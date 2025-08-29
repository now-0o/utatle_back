import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import { LRUCache } from 'lru-cache'
import kuroPkg from 'kuroshiro'
import analyzerPkg from 'kuroshiro-analyzer-kuromoji'

const Kuroshiro = kuroPkg.default || kuroPkg
const KuromojiAnalyzer = analyzerPkg.default || analyzerPkg

const app = express()

/* ───────────────── CORS ───────────────── */
const allow = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
app.use(cors({ origin: allow, methods: ['GET', 'POST'] }))
app.use(express.json())

/* ───────────────── ENV ───────────────── */
const PORT = process.env.PORT || 4000

const DEEPL_KEY = process.env.DEEPL_KEY || ''
const DEEPL_HOST = DEEPL_KEY ? 'https://api-free.deepl.com' : ''
const TRANSLATE_URL = DEEPL_KEY ? `${DEEPL_HOST}/v2/translate` : ''

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const GH_OWNER = 'EX3exp'
const GH_REPO = 'Kpop-lyric-datasets'
const GH_BRANCH = 'main'

const YEAR_MIN = 2000
const YEAR_MAX = 2023

/* ───────────────── LRU Cache ───────────────── */
const cache = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 })

/* ───────────────── Helpers ───────────────── */
const pad2 = (n) => String(n).padStart(2, '0')
const pad3 = (n) => String(n).padStart(3, '0')

const makeCode = (y, m, rank) => `${y}${pad2(m)}${pad3(rank)}`
const parseCode = (code) => {
  const s = String(code).replace(/\D/g, '')
  if (s.length < 9) return null
  const year = Number(s.slice(0, 4))
  const month = Number(s.slice(4, 6))
  const rank = Number(s.slice(6, 9))
  if (!year || !month || !rank) return null
  return { year, month, rank }
}

/* ───────────────── Kuroshiro ───────────────── */
const kuro = new Kuroshiro()
let kuroReady = false
async function ensureKuroReady() {
  if (kuroReady) return
  await kuro.init(new KuromojiAnalyzer({ dictPath: 'node_modules/kuromoji/dict' }))
  kuroReady = true
}

/* ───────────────── GitHub fetch ───────────────── */
const ghRepoPath = (y, m, rank) =>
  `melon/monthly-chart/melon-${y}/melon-${y}-${pad2(m)}/melon-monthly_${y}-${pad2(m)}_${rank}.json`

const ghApiUrl = (path) =>
  `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`

async function fetchJsonFromGitHub(path) {
  const k = `gh:${path}`
  const hit = cache.get(k)
  if (hit) return hit

  const headers = { Accept: 'application/vnd.github+json' }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`

  const r = await fetch(ghApiUrl(path), { headers })
  if (!r.ok) throw new Error(`GH ${r.status}`)

  const meta = await r.json()
  const buf = Buffer.from(String(meta.content || '').replace(/\n/g, ''), 'base64')
  const raw = JSON.parse(buf.toString('utf8'))

  cache.set(k, raw)
  return raw
}

function extractLines(raw) {
  if (raw?.lyrics?.lines)
    return raw.lyrics.lines.map((x) => String(x ?? '')).filter(Boolean)
  if (Array.isArray(raw?.lyrics))
    return raw.lyrics.map((l) => l?.text ?? '').filter(Boolean)
  return []
}

async function fetchSong(y, m, rank) {
  const raw = await fetchJsonFromGitHub(ghRepoPath(y, m, rank))
  const lines = extractLines(raw)
  const genre = String(raw?.genre ?? raw?.category ?? '').trim()
  return {
    year: Number(y),
    month: Number(m),
    rank: Number(raw?.rank ?? rank),
    title: String(raw?.song_name ?? raw?.title ?? ''),
    artist: String(raw?.artist ?? ''),
    genre,
    lines,
  }
}

async function pickOneFromMonth(year, month) {
  const tried = new Set()
  for (let i = 0; i < 60; i++) {
    const rank = 1 + Math.floor(Math.random() * 100)
    if (tried.has(rank)) continue
    tried.add(rank)
    try {
      const s = await fetchSong(year, month, rank)
      if (s.lines?.length) return s
    } catch {}
  }
  throw new Error('no_song_in_month')
}

async function pickRandomGlobal() {
  for (let i = 0; i < 150; i++) {
    const y = YEAR_MIN + Math.floor(Math.random() * (YEAR_MAX - YEAR_MIN + 1))
    const m = 1 + Math.floor(Math.random() * 12)
    try {
      const s = await pickOneFromMonth(y, m)
      return s
    } catch {}
  }
  throw new Error('random_pick_failed')
}

/* ───────────────── DeepL 번역 (KO→JA) ───────────────── */
async function deeplTranslateLinesKoToJa(lines) {
  if (!DEEPL_KEY || !TRANSLATE_URL) return lines.slice()
  const out = new Array(lines.length)
  const batchSize = 40

  for (let i = 0; i < lines.length; i += batchSize) {
    const batch = lines.slice(i, i + batchSize)

    const cached = batch.map((t) => cache.get(`ko->ja:${t}`) || null)
    const need = []
    cached.forEach((v, idx) => {
      if (v == null) need.push({ idx, text: batch[idx] })
    })

    if (need.length) {
      const params = new URLSearchParams()
      params.append('auth_key', DEEPL_KEY)
      need.forEach(({ text }) => params.append('text', text))
      params.append('target_lang', 'JA')

      const r = await fetch(TRANSLATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      })

      if (!r.ok) {
        // 실패 시 원문 유지
        need.forEach(({ idx }) => {
          cached[idx] = batch[idx]
        })
      } else {
        const j = await r.json()
        const arr = (j?.translations || []).map((x) => x?.text ?? '')
        need.forEach(({ idx }, k) => {
          cached[idx] = arr[k] ?? batch[idx]
          cache.set(`ko->ja:${batch[idx]}`, cached[idx])
        })
      }
    }

    cached.forEach((v, idx) => {
      out[i + idx] = v ?? batch[idx]
    })
  }

  return out
}

/* ───────────────── Furigana 변환 ───────────────── */
async function makeRubyFromJaLineAsync(line) {
  if (!line) return ''
  const k = `ruby:${line}`
  const hit = cache.get(k)
  if (hit) return hit
  await ensureKuroReady()
  const out = await kuro.convert(line, { mode: 'furigana', to: 'hiragana' })
  cache.set(k, out)
  return out
}

async function packResponseAsync(song, jaLines, koLines) {
  const rubyLines = await Promise.all(jaLines.map(makeRubyFromJaLineAsync))
  return {
    year: song.year,
    month: song.month,
    rank: song.rank,
    title: song.title,
    artist: song.artist,
    genre: song.genre || '',
    code: makeCode(song.year, song.month, song.rank),
    lyricsKoLines: koLines,
    lyricsJaLines: jaLines,
    lyricsJaRubyLines: rubyLines,
  }
}

/* ───────────────── Genre Pick Helper ───────────────── */
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

async function pickByGenre(genre) {
  const wanted = norm(genre)
  for (let i = 0; i < 350; i++) {
    const y = YEAR_MIN + Math.floor(Math.random() * (YEAR_MAX - YEAR_MIN + 1))
    const m = 1 + Math.floor(Math.random() * 12)
    try {
      const s = await pickOneFromMonth(y, m)
      if (norm(s.genre).includes(wanted)) return s
    } catch {}
  }
  throw new Error('no_song_for_genre')
}

/* ───────────────── Routes ───────────────── */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

// 단일 텍스트 KO->JA 번역 (테스트용)
app.post('/api/translate', async (req, res) => {
  try {
    const { text } = req.body || {}
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text_required' })
    const [ja] = await deeplTranslateLinesKoToJa([text])
    res.json({ textJa: ja })
  } catch {
    res.status(500).json({ error: 'translate_failed' })
  }
})

// 월도 선택
app.get('/api/quiz/by-month', async (req, res) => {
  try {
    const y = Number(req.query.year)
    const m = Number(req.query.month)
    if (!y || !m) return res.status(400).json({ error: 'year_month_required' })
    const song = await pickOneFromMonth(y, m)
    const koLines = (song.lines || []).map((s) => String(s || '').trim()).filter(Boolean)
    const jaLines = await deeplTranslateLinesKoToJa(koLines)
    res.json(await packResponseAsync(song, jaLines, koLines))
  } catch {
    res.status(502).json({ error: 'fetch_failed' })
  }
})

// 전체 랜덤
app.get('/api/quiz/random', async (req, res) => {
  try {
    const song = await pickRandomGlobal()
    const koLines = (song.lines || []).map((s) => String(s || '').trim()).filter(Boolean)
    const jaLines = await deeplTranslateLinesKoToJa(koLines)
    res.json(await packResponseAsync(song, jaLines, koLines))
  } catch {
    res.status(502).json({ error: 'fetch_failed' })
  }
})

// 매칭 코드로 로드
app.get('/api/quiz/by-code', async (req, res) => {
  try {
    const code = req.query.code
    const parsed = parseCode(code)
    if (!parsed) return res.status(400).json({ error: 'bad_code' })
    const song = await fetchSong(parsed.year, parsed.month, parsed.rank)
    const koLines = (song.lines || []).map((s) => String(s || '').trim()).filter(Boolean)
    const jaLines = await deeplTranslateLinesKoToJa(koLines)
    res.json(await packResponseAsync(song, jaLines, koLines))
  } catch {
    res.status(502).json({ error: 'fetch_failed' })
  }
})

// 장르로 랜덤
app.get('/api/quiz/by-genre', async (req, res) => {
  try {
    const genre = String(req.query.genre || '').trim()
    if (!genre) return res.status(400).json({ error: 'genre_required' })
    const song = await pickByGenre(genre)
    const koLines = (song.lines || []).map((s) => String(s || '').trim()).filter(Boolean)
    const jaLines = await deeplTranslateLinesKoToJa(koLines)
    res.json(await packResponseAsync(song, jaLines, koLines))
  } catch {
    res.status(502).json({ error: 'fetch_failed' })
  }
})

/* ───────────────── Start ───────────────── */
ensureKuroReady()
  .then(() => console.log('Kuroshiro ready (preloaded)'))
  .catch((e) => console.error('Kuroshiro init failed', e))

app.listen(PORT, () => {
  console.log(`✅ utatle_back on http://localhost:${PORT}`)
})
