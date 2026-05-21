// APEX Trade — Trading Dashboard Server
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const AV_KEY  = process.env.ALPHA_VANTAGE_KEY || "demo";
const FH_KEY  = process.env.FINNHUB_KEY       || "";
const OAI_KEY = process.env.OPENAI_KEY        || "";

const HAS_AV  = Boolean(AV_KEY  && AV_KEY  !== "demo" && AV_KEY  !== "your_key_here");
const HAS_FH  = Boolean(FH_KEY  && FH_KEY  !== "your_key_here");
const HAS_OAI = Boolean(OAI_KEY && OAI_KEY !== "your_key_here");

// ── SYMBOL MAP ────────────────────────────────────────────────────────────────
const SYMBOLS = {
  NDQ:    { av:"QQQ", fh:"QQQ", name:"NASDAQ 100",     type:"index",     base:456, newsKeywords:["nasdaq","nasdaq 100","tech","qqq","nvidia","apple","microsoft"] },
  US30:   { av:"DIA", fh:"DIA", name:"Dow Jones 30",   type:"index",     base:390, newsKeywords:["dow","dow jones","wall street","industrial","us 30","dia"] },
  SP500:  { av:"SPY", fh:"SPY", name:"S&P 500",        type:"index",     base:524, newsKeywords:["s&p","s&p 500","spx","spy","us 500","wall street","equities"] },
  GOLD:   { av:"GLD", fh:"GLD", name:"Gold",           type:"commodity", base:216, newsKeywords:["gold","xau","xauusd","bullion","precious metal"] },
  SILVER: { av:"SLV", fh:"SLV", name:"Silver",         type:"commodity", base:27,  newsKeywords:["silver","xag","xagusd","precious metal"] },
  GS:     { av:"GS",  fh:"GS",  name:"Goldman Sachs",  type:"stock",     base:458, newsKeywords:["goldman","goldman sachs","banks","banking","financials"] },
  MS:     { av:"MS",  fh:"MS",  name:"Morgan Stanley", type:"stock",     base:98,  newsKeywords:["morgan stanley","banks","banking","financials"] },
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let marketCache       = {};
let lastUpdated       = null;
let refreshInProgress = false;
let refreshStatus     = "Booting with sample data";
let aiNarrativeCache  = {};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const isFiniteNum = v => Number.isFinite(toNum(v));
const toNum  = v => typeof v === "string" ? parseFloat(v.replace(/[%,]/g,"")) : Number(v);
const round  = (v,d=2) => isFiniteNum(v) ? Number(toNum(v).toFixed(d)) : null;
const getToday = (off=0) => new Date(Date.now()+off*86400000).toISOString().split("T")[0];
const stripTags = s => String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const uniqueByUrl = items => { const s=new Set(); return items.filter(i=>{ const k=(i.url||i.headline||"").toLowerCase(); if(!k||s.has(k))return false; s.add(k);return true;}); };

function normalizeQuote(raw) {
  if (!raw||!isFiniteNum(raw.price)) return null;
  const price     = round(raw.price);
  const open      = round(raw.open      ?? raw.prevClose ?? price);
  const high      = round(raw.high      ?? Math.max(price,open));
  const low       = round(raw.low       ?? Math.min(price,open));
  const prevClose = round(raw.prevClose ?? open);
  const change    = round(raw.change    ?? price-prevClose);
  const changePct = round(raw.changePct ?? (prevClose?(change/prevClose)*100:0));
  return { price,open,high,low,prevClose,change,changePct, volume:Math.max(0,Math.round(toNum(raw.volume)||0)) };
}

// ── SAMPLE BARS ───────────────────────────────────────────────────────────────
function makeSampleBars(id, meta, days=60) {
  let close=meta.base; const bars=[];
  for (let i=days-1;i>=0;i--) {
    const idx=days-i;
    const w=Math.sin((idx+1)*(id.length+3)*0.41)+Math.cos((idx+5)*0.29);
    const drift=meta.type==="commodity"?0.0008:0.0012;
    const open=close; close=Math.max(1,close*(1+drift+w*0.006));
    bars.push({ date:getToday(-i), open:round(open),
      high:round(Math.max(open,close)*(1+Math.abs(w)*0.005+0.002)),
      low:round(Math.min(open,close)*(1-Math.abs(w)*0.005-0.002)),
      close:round(close), volume:Math.round(meta.base*90000*(1+Math.abs(w)*0.45)) });
  }
  return bars;
}

function quoteFromBars(bars) {
  const l=bars[bars.length-1], p=bars[bars.length-2]||l;
  return normalizeQuote({ price:l.close,open:l.open,high:l.high,low:l.low,
    prevClose:p.close,change:l.close-p.close,
    changePct:p.close?((l.close-p.close)/p.close)*100:0,volume:l.volume });
}

// ── TECHNICALS ────────────────────────────────────────────────────────────────
function calcRSI(closes,period=14) {
  if (closes.length<period+1) return null;
  let g=0,l=0;
  for (let i=closes.length-period;i<closes.length;i++) {
    const d=closes[i]-closes[i-1]; if(d>0)g+=d; else l-=d;
  }
  const rs=(g/period)/(l/period||0.0001);
  return round(100-100/(1+rs));
}
function calcEMA(closes,period) {
  if (closes.length<period) return null;
  const k=2/(period+1); let e=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<closes.length;i++) e=closes[i]*k+e*(1-k);
  return round(e,4);
}
function calcMACD(closes) {
  const e12=calcEMA(closes,12),e26=calcEMA(closes,26);
  return (e12&&e26)?round(e12-e26,4):null;
}
function calcBB(closes,period=20) {
  if (closes.length<period) return null;
  const sl=closes.slice(-period), mean=sl.reduce((a,b)=>a+b,0)/period;
  const std=Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/period);
  return { upper:round(mean+2*std),middle:round(mean),lower:round(mean-2*std) };
}
function getSeasonalBias(type) {
  const m=new Date().getMonth();
  const maps={ index:[0.6,0.5,0.55,0.6,0.45,0.4,0.5,0.55,0.45,0.6,0.65,0.7],
               commodity:[0.6,0.55,0.5,0.45,0.5,0.55,0.6,0.65,0.7,0.6,0.55,0.6],
               stock:[0.55,0.5,0.55,0.6,0.5,0.45,0.55,0.6,0.5,0.65,0.65,0.65] };
  return (maps[type]||maps.index)[m];
}

function generateSignal(quote,bars,type) {
  if (!quote||!Array.isArray(bars)||bars.length<26)
    return { signal:"NEUTRAL",confidence:50,reasoning:["Insufficient data"],score:0 };
  const closes=bars.map(b=>b.close).filter(isFiniteNum);
  const volumes=bars.map(b=>toNum(b.volume)||0);
  const rsi=calcRSI(closes), ema9=calcEMA(closes,9), ema21=calcEMA(closes,21);
  const macd=calcMACD(closes), bb=calcBB(closes);
  const avgVol=volumes.slice(-20).reduce((a,b)=>a+b,0)/20||1;
  const volRatio=(volumes[volumes.length-1]||avgVol)/avgVol;
  const seasonal=getSeasonalBias(type);
  let score=0; const reasoning=[];

  if (rsi!==null) {
    if      (rsi<35){ score+=1.5; reasoning.push(`RSI ${rsi} — oversold, bullish bias`); }
    else if (rsi<45){ score+=0.5; reasoning.push(`RSI ${rsi} — approaching oversold`); }
    else if (rsi>65){ score-=1.5; reasoning.push(`RSI ${rsi} — overbought, bearish bias`); }
    else if (rsi>55){ score-=0.5; reasoning.push(`RSI ${rsi} — approaching overbought`); }
    else             { reasoning.push(`RSI ${rsi} — neutral zone`); }
  }
  if (ema9!==null&&ema21!==null) {
    ema9>ema21 ? (score+=1,reasoning.push("EMA 9 > EMA 21 — bullish trend"))
               : (score-=1,reasoning.push("EMA 9 < EMA 21 — bearish trend"));
  }
  if (macd!==null) {
    macd>0 ? (score+=0.5,reasoning.push(`MACD ${macd} — positive momentum`))
           : (score-=0.5,reasoning.push(`MACD ${macd} — negative momentum`));
  }
  if (bb&&quote.price) {
    if      (quote.price<bb.lower){ score+=0.8; reasoning.push("Price below Bollinger lower — reversal potential"); }
    else if (quote.price>bb.upper){ score-=0.8; reasoning.push("Price above Bollinger upper — reversal risk"); }
  }
  volRatio>1.5 ? (score+=0.5,reasoning.push(`Volume ${volRatio.toFixed(1)}x avg — strong momentum`))
               : volRatio<0.6&&(score-=0.3,reasoning.push("Volume low — weak conviction"));
  quote.price>quote.open ? (score+=0.3,reasoning.push("Price above open — intraday strength"))
                         : (score-=0.3,reasoning.push("Price below open — intraday weakness"));
  const month=new Date().toLocaleString("default",{month:"long"});
  seasonal>0.58 ? (score+=0.5,reasoning.push(`Seasonal bias bullish for ${month}`))
                : seasonal<0.47&&(score-=0.5,reasoning.push(`Seasonal bias bearish for ${month}`));

  let signal,confidence;
  if      (score>2)  { signal="STRONG BUY";  confidence=Math.min(92,65+score*5); }
  else if (score>0.5){ signal="BUY";         confidence=Math.min(78,55+score*7); }
  else if (score<-2) { signal="STRONG SELL"; confidence=Math.min(92,65+Math.abs(score)*5); }
  else if (score<-0.5){ signal="SELL";       confidence=Math.min(78,55+Math.abs(score)*7); }
  else               { signal="NEUTRAL";     confidence=50; }

  return { signal,confidence:Math.round(confidence),rsi,
    ema9:ema9?.toFixed(2),ema21:ema21?.toFixed(2),macd:macd?.toFixed(4),
    bb,volRatio:volRatio.toFixed(2),seasonal:`${(seasonal*100).toFixed(0)}%`,
    reasoning,score:round(score) };
}

// ── OPENAI NARRATIVE ──────────────────────────────────────────────────────────
async function generateAINarrative(id, instrument) {
  if (!HAS_OAI) return null;
  const cached=aiNarrativeCache[id];
  if (cached&&Date.now()-cached.generatedAt<15*60*1000) return cached.text;
  try {
    const { quote,signal,name } = instrument;
    const headlines=(instrument.news||[]).slice(0,3).map(n=>n.headline).filter(Boolean).join("; ");
    const prompt=`You are a professional market analyst for APEX Trade. Given this data for ${name}:
- Price: $${quote.price} | Change: ${quote.changePct>=0?"+":""}${quote.changePct}%
- Signal: ${signal.signal} (${signal.confidence}% confidence) | Score: ${signal.score}
- RSI: ${signal.rsi} | EMA9/21: ${signal.ema9}/${signal.ema21} | MACD: ${signal.macd||"N/A"}
- Volume: ${signal.volRatio}x average | Bollinger: ${signal.bb?`${signal.bb.lower}–${signal.bb.upper}`:"N/A"}
- Analysis: ${signal.reasoning.slice(0,3).join("; ")}
${headlines?`- Headlines: ${headlines}`:""}
Write 2–3 concise, professional sentences for traders. Be direct and specific. No disclaimers.`;

    const { data } = await axios.post("https://api.openai.com/v1/chat/completions",
      { model:"gpt-3.5-turbo", max_tokens:120, temperature:0.35,
        messages:[{ role:"user",content:prompt }] },
      { timeout:10000, headers:{ Authorization:`Bearer ${OAI_KEY}`, "Content-Type":"application/json" } });
    const text=data.choices?.[0]?.message?.content?.trim()||null;
    if (text) aiNarrativeCache[id]={ text, generatedAt:Date.now() };
    return text;
  } catch(e) { console.error(`OpenAI ${id}:`,e.message); return null; }
}

// ── DATA FETCHERS ─────────────────────────────────────────────────────────────
async function fetchFHQuote(symbol) {
  if (!HAS_FH) return null;
  try {
    const { data }=await axios.get("https://finnhub.io/api/v1/quote",
      { timeout:6000,params:{ symbol,token:FH_KEY } });
    if (!data||!isFiniteNum(data.c)||toNum(data.c)<=0) return null;
    return normalizeQuote({ price:data.c,open:data.o,high:data.h,low:data.l,
      prevClose:data.pc,change:toNum(data.c)-toNum(data.pc||data.o||data.c),changePct:data.dp,volume:0 });
  } catch(e){ console.error(`FH quote ${symbol}:`,e.message); return null; }
}

async function fetchAVQuote(symbol) {
  if (!HAS_AV) return null;
  try {
    const { data }=await axios.get("https://www.alphavantage.co/query",
      { timeout:8000,params:{ function:"GLOBAL_QUOTE",symbol,apikey:AV_KEY } });
    const q=data["Global Quote"];
    if (!q||!q["05. price"]) return null;
    return normalizeQuote({ price:q["05. price"],open:q["02. open"],high:q["03. high"],
      low:q["04. low"],prevClose:q["08. previous close"],
      change:q["09. change"],changePct:q["10. change percent"],volume:q["06. volume"] });
  } catch(e){ console.error(`AV quote ${symbol}:`,e.message); return null; }
}

async function fetchAVDaily(symbol) {
  if (!HAS_AV) return [];
  try {
    const { data }=await axios.get("https://www.alphavantage.co/query",
      { timeout:10000,params:{ function:"TIME_SERIES_DAILY",symbol,outputsize:"compact",apikey:AV_KEY } });
    const ts=data["Time Series (Daily)"]; if (!ts) return [];
    return Object.entries(ts).slice(0,60)
      .map(([date,v])=>({ date,open:round(v["1. open"]),high:round(v["2. high"]),
        low:round(v["3. low"]),close:round(v["4. close"]),volume:parseInt(v["5. volume"],10)||0 }))
      .filter(b=>isFiniteNum(b.close)).reverse();
  } catch(e){ console.error(`AV daily ${symbol}:`,e.message); return []; }
}

async function fetchFHNews(symbol) {
  if (!HAS_FH) return [];
  try {
    const { data }=await axios.get("https://finnhub.io/api/v1/company-news",
      { timeout:6000,params:{ symbol,from:getToday(-7),to:getToday(),token:FH_KEY } });
    return (data||[]).slice(0,5).map(n=>({
      headline:n.headline,source:n.source,url:n.url,summary:n.summary||"",
      sentiment:null,publishedAt:n.datetime?new Date(n.datetime*1000).toISOString():null }));
  } catch(e){ console.error(`FH news ${symbol}:`,e.message); return []; }
}

async function fetchFHMarketNews() {
  if (!HAS_FH) return [];
  try {
    const { data }=await axios.get("https://finnhub.io/api/v1/news",
      { timeout:6000,params:{ category:"general",token:FH_KEY } });
    return (data||[]).slice(0,15).map(n=>({
      headline:n.headline,source:n.source,url:n.url,summary:n.summary||"",
      sentiment:null,publishedAt:n.datetime?new Date(n.datetime*1000).toISOString():null }));
  } catch(e){ console.error("FH market news:",e.message); return []; }
}

const FALLBACK_NEWS=[
  { headline:"Fed holds rates steady, signals patience on cuts",source:"Reuters",url:"https://www.reuters.com",summary:"Federal Reserve keeps rates unchanged.",sentiment:"mixed",publishedAt:null },
  { headline:"S&P 500 edges higher as tech leads gains",source:"CNBC",url:"https://www.cnbc.com",summary:"Technology stocks led broad market gains.",sentiment:"bullish",publishedAt:null },
  { headline:"Gold retreats from record high as dollar firms",source:"Bloomberg",url:"https://www.bloomberg.com",summary:"Gold prices pulled back after recent highs.",sentiment:"bearish",publishedAt:null },
  { headline:"Nasdaq 100 eyes resistance as AI optimism returns",source:"MarketWatch",url:"https://www.marketwatch.com",summary:"Tech stocks rebound on AI sector optimism.",sentiment:"bullish",publishedAt:null },
  { headline:"Morgan Stanley raises equity targets on earnings beat",source:"Reuters",url:"https://www.reuters.com",summary:"Wall Street bank upgrades forecasts.",sentiment:"bullish",publishedAt:null },
];

function analyzeNewsRelevance(item,meta) {
  const text=`${item.headline||""} ${item.summary||""}`.toLowerCase();
  const direct=(meta.newsKeywords||[]).filter(k=>text.includes(k.toLowerCase()));
  const macro=["fed","rates","inflation","cpi","dollar","yields","recession","earnings"].filter(k=>text.includes(k));
  let score=direct.length*3+macro.length;
  if (meta.type==="index"&&/stocks|equities|nasdaq|s&p|dow/i.test(text)) score+=2;
  if (meta.type==="commodity"&&/gold|silver|xau|xag|dollar|yields/i.test(text)) score+=2;
  if (meta.type==="stock"&&/bank|financial|earnings/i.test(text)) score+=2;
  const bull=["bullish","rally","higher","gain","surge","record","rebound"].filter(w=>text.includes(w)).length;
  const bear=["bearish","selloff","lower","drop","pressure","weak","falls"].filter(w=>text.includes(w)).length;
  const tone=bull>bear?"bullish":bear>bull?"bearish":"mixed";
  return { ...item, sentiment:item.sentiment||tone, relevanceScore:score,
    relevance:direct.length?`Matched: ${direct.slice(0,3).join(", ")}`
      :macro.length?`Macro: ${macro.slice(0,3).join(", ")}`:"General context",
    analysis:`${tone.toUpperCase()} — ${score>=5?"high":score>=3?"medium":"light"} relevance` };
}

async function fetchRelevantNews(symbol, meta) {
  const [company,market]=await Promise.all([
    fetchFHNews(symbol),
    (meta.type==="index"||meta.type==="commodity")?fetchFHMarketNews():Promise.resolve([])
  ]);
  return uniqueByUrl([...company,...market,...FALLBACK_NEWS])
    .map(i=>analyzeNewsRelevance(i,meta))
    .sort((a,b)=>b.relevanceScore-a.relevanceScore).slice(0,6);
}

// ── BUILD & REFRESH ───────────────────────────────────────────────────────────
function buildInstrument(id,meta,quote,bars,news,source,note) {
  const usableBars=Array.isArray(bars)&&bars.length>=26?bars:makeSampleBars(id,meta);
  const usableQuote=normalizeQuote(quote)||quoteFromBars(usableBars);
  const signal=generateSignal(usableQuote,usableBars,meta.type);
  if (note) signal.reasoning.unshift(note);
  return { id,name:meta.name,type:meta.type,quote:usableQuote,
    bars:usableBars.slice(-60),signal,news:news||[],source,updatedAt:new Date().toISOString() };
}

function seedMarketCache() {
  marketCache=Object.fromEntries(Object.entries(SYMBOLS).map(([id,meta])=>{
    const bars=makeSampleBars(id,meta);
    return [id,buildInstrument(id,meta,quoteFromBars(bars),bars,[],"sample","Sample data — live providers loading")];
  }));
  lastUpdated=new Date().toISOString();
}

async function refreshOne(id,meta) {
  try {
    const [fhQuote,news,avBars]=await Promise.all([
      fetchFHQuote(meta.fh), fetchRelevantNews(meta.fh,meta), fetchAVDaily(meta.av)
    ]);
    const avQuote=fhQuote?null:await fetchAVQuote(meta.av);
    const liveQuote=fhQuote||avQuote;
    const existing=marketCache[id];
    const bars=avBars.length?avBars:existing?.bars;
    const quote=liveQuote||existing?.quote;
    const source=liveQuote||avBars.length?"live":"sample";
    marketCache[id]=buildInstrument(id,meta,quote,bars,news,source,
      source==="live"?"Live data connected":"Sample data — check API keys in Railway");
  } catch(e){ console.error(`refreshOne ${id}:`,e.message); }
}

async function refreshMarketData() {
  if (refreshInProgress) return;
  refreshInProgress=true; refreshStatus="Refreshing...";
  console.log("[refresh] Starting...");
  try {
    const entries=Object.entries(SYMBOLS);
    for (let i=0;i<entries.length;i++) {
      const [id,meta]=entries[i];
      if (HAS_AV&&i>0) await new Promise(r=>setTimeout(r,13000));
      await refreshOne(id,meta);
    }
    lastUpdated=new Date().toISOString(); refreshStatus="Live data loaded";
    console.log("[refresh] Done.");
  } catch(e){ refreshStatus="Refresh failed — showing last snapshot"; console.error("[refresh]",e.message); }
  finally { refreshInProgress=false; }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/api/market",(req,res)=>
  res.json({ data:marketCache,lastUpdated,refreshInProgress,status:refreshStatus,
    providers:{ alphaVantage:HAS_AV,finnhub:HAS_FH,openai:HAS_OAI } }));

app.get("/api/market/:id",(req,res)=>{
  const id=req.params.id.toUpperCase();
  if (!marketCache[id]) return res.status(404).json({ error:"Symbol not found" });
  res.json(marketCache[id]);
});

app.get("/api/narrative/:id",async(req,res)=>{
  const id=req.params.id.toUpperCase();
  if (!marketCache[id]) return res.status(404).json({ error:"Symbol not found" });
  if (!HAS_OAI) return res.json({ narrative:"Add OPENAI_KEY to Railway environment variables to enable AI commentary." });
  const narrative=await generateAINarrative(id,marketCache[id]);
  res.json({ narrative:narrative||"AI commentary temporarily unavailable." });
});

app.post("/api/refresh",(req,res)=>{
  if (!refreshInProgress) refreshMarketData();
  res.json({ message:"Refresh triggered",refreshInProgress:true });
});

app.get("/api/news/:id",async(req,res)=>{
  const id=req.params.id.toUpperCase(), meta=SYMBOLS[id];
  if (!meta) return res.status(404).json({ error:"Symbol not found" });
  res.json({ news:await fetchRelevantNews(meta.fh,meta) });
});

app.get("/health",(req,res)=>
  res.json({ status:"ok",lastUpdated,refreshInProgress,refreshStatus,
    providers:{ alphaVantage:HAS_AV,finnhub:HAS_FH,openai:HAS_OAI },
    cachedSymbols:Object.keys(marketCache).length }));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// ── BOOT ──────────────────────────────────────────────────────────────────────
app.listen(PORT,()=>{
  console.log(`APEX Trade running on port ${PORT}`);
  console.log(`Providers — AV:${HAS_AV} | FH:${HAS_FH} | OAI:${HAS_OAI}`);
  seedMarketCache();
  refreshMarketData();
  setInterval(refreshMarketData,5*60*1000);
});
