require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Set these in Railway's Environment Variables panel:
//   ALPHA_VANTAGE_KEY  → free key from alphavantage.co  (stocks, forex, commodities)
//   FINNHUB_KEY        → free key from finnhub.io        (real-time quotes + news)
//   OPENAI_KEY         → optional, for AI signal text generation
const AV_KEY      = process.env.ALPHA_VANTAGE_KEY || "demo";
const FH_KEY      = process.env.FINNHUB_KEY       || "";
const OPENAI_KEY  = process.env.OPENAI_KEY        || "";

// ─── SYMBOL MAP ──────────────────────────────────────────────────────────────
// Maps our internal IDs → provider-specific symbols
const SYMBOLS = {
  NDQ:   { av: "QQQ",    fh: "QQQ",      name: "NASDAQ 100",   type: "index" },
  US30:  { av: "DIA",    fh: "DIA",      name: "Dow Jones 30", type: "index" },
  SP500: { av: "SPY",    fh: "SPY",      name: "S&P 500",      type: "index" },
  GOLD:  { av: "GLD",    fh: "GLD",      name: "Gold",         type: "commodity" },
  SILVER:{ av: "SLV",    fh: "SLV",      name: "Silver",       type: "commodity" },
  GS:    { av: "GS",     fh: "GS",       name: "Goldman Sachs",type: "stock" },
  MS:    { av: "MS",     fh: "MS",       name: "Morgan Stanley",type: "stock" },
};

// ─── IN-MEMORY CACHE (refreshed every 60s) ───────────────────────────────────
let marketCache = {};
let lastUpdated  = null;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Fetch a global quote from Alpha Vantage */
async function fetchAVQuote(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const q = data["Global Quote"];
    if (!q || !q["05. price"]) return null;
    return {
      price:   parseFloat(q["05. price"]),
      open:    parseFloat(q["02. open"]),
      high:    parseFloat(q["03. high"]),
      low:     parseFloat(q["04. low"]),
      prevClose: parseFloat(q["08. previous close"]),
      change:  parseFloat(q["09. change"]),
      changePct: parseFloat(q["10. change percent"]),
      volume:  parseInt(q["06. volume"]),
    };
  } catch (e) {
    console.error(`AV fetch error for ${symbol}:`, e.message);
    return null;
  }
}

/** Fetch daily OHLCV for RSI / technicals (last 50 bars) */
async function fetchAVDaily(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=compact&apikey=${AV_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const ts = data["Time Series (Daily)"];
    if (!ts) return [];
    return Object.entries(ts)
      .slice(0, 50)
      .map(([date, v]) => ({
        date,
        open:   parseFloat(v["1. open"]),
        high:   parseFloat(v["2. high"]),
        low:    parseFloat(v["3. low"]),
        close:  parseFloat(v["4. close"]),
        volume: parseInt(v["5. volume"]),
      }))
      .reverse(); // oldest first
  } catch (e) {
    console.error(`AV daily error for ${symbol}:`, e.message);
    return [];
  }
}

/** Calculate RSI-14 from close array */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

/** Calculate EMA */
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(4));
}

/** Seasonal bias: very simplified — month-based tendencies */
function getSeasonalBias(type) {
  const month = new Date().getMonth(); // 0=Jan
  // Rough historical tendencies (illustrative)
  const indexBias  = [0.6, 0.5, 0.55, 0.6, 0.45, 0.4, 0.5, 0.55, 0.45, 0.6, 0.65, 0.7];
  const goldBias   = [0.6, 0.55, 0.5, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.6, 0.55, 0.6];
  const stockBias  = [0.55, 0.5, 0.55, 0.6, 0.5, 0.45, 0.55, 0.6, 0.5, 0.65, 0.65, 0.65];
  if (type === "commodity") return goldBias[month];
  if (type === "stock")     return stockBias[month];
  return indexBias[month];
}

/** AI signal engine: combines RSI + EMA cross + volume + seasonal */
function generateSignal(quote, bars, type) {
  if (!quote || bars.length < 26) {
    return { signal: "NEUTRAL", confidence: 50, reasoning: ["Insufficient data"] };
  }

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const rsi     = calcRSI(closes);
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const avgVol  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volRatio = lastVol / avgVol;
  const seasonal = getSeasonalBias(type);

  let score = 0;       // ranges roughly -4 to +4
  const reasoning = [];

  // RSI
  if (rsi !== null) {
    if (rsi < 35)       { score += 1.5; reasoning.push(`RSI ${rsi} — oversold, bullish bias`); }
    else if (rsi < 45)  { score += 0.5; reasoning.push(`RSI ${rsi} — approaching oversold`); }
    else if (rsi > 65)  { score -= 1.5; reasoning.push(`RSI ${rsi} — overbought, bearish bias`); }
    else if (rsi > 55)  { score -= 0.5; reasoning.push(`RSI ${rsi} — approaching overbought`); }
    else                { reasoning.push(`RSI ${rsi} — neutral zone`); }
  }

  // EMA cross
  if (ema9 && ema21) {
    if (ema9 > ema21)   { score += 1; reasoning.push(`EMA 9 above EMA 21 — bullish trend`); }
    else                { score -= 1; reasoning.push(`EMA 9 below EMA 21 — bearish trend`); }
  }

  // Volume
  if (volRatio > 1.5)   { score += 0.5; reasoning.push(`Volume ${(volRatio).toFixed(1)}× avg — strong momentum`); }
  else if (volRatio < 0.6) { score -= 0.3; reasoning.push(`Volume low — weak conviction`); }

  // Price vs open
  if (quote.price > quote.open) { score += 0.3; reasoning.push("Price above open — intraday strength"); }
  else                          { score -= 0.3; reasoning.push("Price below open — intraday weakness"); }

  // Seasonal
  if (seasonal > 0.58)  { score += 0.5; reasoning.push(`Seasonal bias bullish for ${new Date().toLocaleString("default",{month:"long"})}`); }
  else if (seasonal < 0.47) { score -= 0.5; reasoning.push(`Seasonal bias bearish for ${new Date().toLocaleString("default",{month:"long"})}`); }

  // Map score → signal + confidence
  let signal, confidence;
  if      (score >  2)  { signal = "STRONG BUY";  confidence = Math.min(90, 65 + score * 5); }
  else if (score >  0.5){ signal = "BUY";          confidence = Math.min(75, 55 + score * 7); }
  else if (score < -2)  { signal = "STRONG SELL";  confidence = Math.min(90, 65 + Math.abs(score) * 5); }
  else if (score < -0.5){ signal = "SELL";          confidence = Math.min(75, 55 + Math.abs(score) * 7); }
  else                  { signal = "NEUTRAL";       confidence = 50; }

  return {
    signal,
    confidence: Math.round(confidence),
    rsi,
    ema9: ema9?.toFixed(2),
    ema21: ema21?.toFixed(2),
    volRatio: volRatio.toFixed(2),
    seasonal: (seasonal * 100).toFixed(0) + "%",
    reasoning,
    score: parseFloat(score.toFixed(2)),
  };
}

/** Fetch news headlines from Finnhub */
async function fetchNews(symbol) {
  if (!FH_KEY) return [];
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const url   = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${week}&to=${today}&token=${FH_KEY}`;
    const { data } = await axios.get(url, { timeout: 8000 });
    return (data || []).slice(0, 4).map(n => ({
      headline: n.headline,
      source: n.source,
      url: n.url,
      sentiment: n.sentiment || null,
    }));
  } catch (e) { return []; }
}

// ─── MAIN REFRESH FUNCTION ────────────────────────────────────────────────────
async function refreshMarketData() {
  console.log("[refresh] Fetching market data…");
  const entries = Object.entries(SYMBOLS);
  // stagger requests to avoid rate limits (AV free = 5 req/min)
  for (let i = 0; i < entries.length; i++) {
    const [id, meta] = entries[i];
    if (i > 0) await new Promise(r => setTimeout(r, 13000)); // 13s gap

    const [quote, bars, news] = await Promise.all([
      fetchAVQuote(meta.av),
      fetchAVDaily(meta.av),
      fetchNews(meta.fh),
    ]);

    const signal = generateSignal(quote, bars, meta.type);

    marketCache[id] = {
      id,
      name: meta.name,
      type: meta.type,
      quote,
      bars: bars.slice(-30), // last 30 days for mini chart
      signal,
      news,
      updatedAt: new Date().toISOString(),
    };
  }
  lastUpdated = new Date().toISOString();
  console.log("[refresh] Done.");
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// All market data
app.get("/api/market", (req, res) => {
  res.json({ data: marketCache, lastUpdated });
});

// Single symbol
app.get("/api/market/:id", (req, res) => {
  const id = req.params.id.toUpperCase();
  if (!marketCache[id]) return res.status(404).json({ error: "Symbol not found" });
  res.json(marketCache[id]);
});

// Force refresh (admin)
app.post("/api/refresh", async (req, res) => {
  refreshMarketData(); // fire and forget
  res.json({ message: "Refresh triggered" });
});

// Health check for Railway
app.get("/health", (req, res) => res.json({ status: "ok", lastUpdated }));

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await refreshMarketData(); // initial load
  // Refresh every 5 minutes (free API tiers)
  setInterval(refreshMarketData, 5 * 60 * 1000);
});
