import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import { LRUCache } from 'lru-cache'

const app = express()

const allow = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({ origin: allow, methods: ['GET','POST'] }))
app.use(express.json())

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

const cache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 })

function pad2(n){ return String(n).padStart(2,'0') }
function ghRepoPath(y, m, rank){
  const yy = String(y)
  const mm = pad2(m)
  return `melon/monthly-chart/melon-${yy}/melon-${yy}-${mm}/melon-monthly_${yy}-${mm}_${rank}.json`
}
function ghApiUrl(path){
  return `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`
}

async function fetchJsonFromGitHub(path){
  const key = `gh:${path}`
  const hit = cache.get(key)
  if(hit) return hit
  const headers = { 'Accept': 'application/vnd.github+json' }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`
  const r = await fetch(ghApiUrl(path), { headers })
  if(!r.ok){
    const t = await r.text().catch(()=> '')
    throw new Error(`GH ${r.status} ${t.slice(0,200)}`)
  }
  const meta = await r.json()
  if(!meta?.content) throw new Error('GH no content')
  const buf = Buffer.from(String(meta.content).replace(/\n/g,''), 'base64')
  const raw = JSON.parse(buf.toString('utf8'))
  cache.set(key, raw)
  return raw
}

async function fetchSong(y, m, rank){
  const raw = await fetchJsonFromGitHub(ghRepoPath(y,m,rank))
  const lines = raw?.lyrics?.lines
    ? raw.lyrics.lines
    : Array.isArray(raw?.lyrics)
      ? raw.lyrics.map(l => l?.text ?? '').filter(Boolean)
      : []
  return {
    year: Number(y),
    month: Number(m),
    rank: Number(raw?.rank ?? rank),
    title: String(raw?.song_name ?? raw?.title ?? ''),
    artist: String(raw?.artist ?? ''),
    lines
  }
}

async function pickOneFromMonth(year, month){
  const tried = new Set()
  for(let i=0;i<50;i++){
    const rank = 1 + Math.floor(Math.random()*100)
    if(tried.has(rank)) continue
    tried.add(rank)
    try{
      const s = await fetchSong(year, month, rank)
      if(s.lines?.length) return s
    }catch{}
  }
  throw new Error('no_song_in_month')
}

async function pickRandomGlobal(){
  for(let i=0;i<120;i++){
    const y = YEAR_MIN + Math.floor(Math.random()*(YEAR_MAX - YEAR_MIN + 1))
    const m = 1 + Math.floor(Math.random()*12)
    try{
      const s = await pickOneFromMonth(y,m)
      return s
    }catch{}
  }
  throw new Error('random_pick_failed')
}

async function translateKoToJa(text){
  if(!text || !DEEPL_KEY || !TRANSLATE_URL) return text
  const key = `ko->ja:${text}`
  const hit = cache.get(key)
  if(hit) return hit
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    source_lang: 'KO',
    target_lang: 'JA'
  })
  const r = await fetch(TRANSLATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  if(!r.ok){
    return text
  }
  const j = await r.json()
  const out = j?.translations?.[0]?.text ?? text
  cache.set(key, out)
  return out
}

app.get('/health', (req,res)=> res.json({ ok: true, ts: Date.now() }))

app.post('/api/translate', async (req,res)=>{
  try{
    const { text } = req.body || {}
    if(!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' })
    const out = await translateKoToJa(text)
    res.json({ textJa: out })
  }catch{
    res.status(500).json({ error: 'translate_failed' })
  }
})

app.get('/api/quiz/by-month', async (req,res)=>{
  try{
    const y = Number(req.query.year)
    const m = Number(req.query.month)
    if(!y || !m) return res.status(400).json({ error: 'year_month_required' })
    const song = await pickOneFromMonth(y,m)
    const fullKo = (song.lines || []).map(s => String(s||'').trim()).filter(Boolean).join('\n')
    const ja = await translateKoToJa(fullKo)
    res.json({ year: song.year, month: song.month, rank: song.rank, title: song.title, artist: song.artist, lyricsKo: fullKo, lyricsJa: ja })
  }catch{
    res.status(502).json({ error: 'fetch_failed' })
  }
})

app.get('/api/quiz/random', async (req,res)=>{
  try{
    const song = await pickRandomGlobal()
    const fullKo = (song.lines || []).map(s => String(s||'').trim()).filter(Boolean).join('\n')
    const ja = await translateKoToJa(fullKo)
    res.json({ year: song.year, month: song.month, rank: song.rank, title: song.title, artist: song.artist, lyricsKo: fullKo, lyricsJa: ja })
  }catch{
    res.status(502).json({ error: 'fetch_failed' })
  }
})

app.listen(PORT, ()=>{ console.log(`✅ utatle_back on http://localhost:${PORT}`) })
