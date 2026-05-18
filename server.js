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

// CONFIG
// Set these in Railway's Environment Variables panel:
//   ALPHA_VANTAGE_KEY - free key from alphavantage.co
//   FINNHUB_KEY       - free key from finnhub.io
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const FH_KEY = process.env.FINNHUB_KEY || "";

const HAS_AV_KEY = Boolean(AV_KEY && AV_KEY !== "demo" && AV_KEY !== "your_key_here");
const HAS_FH_KEY = Boolean(FH_KEY && FH_KEY !== "your_key_here");

// SYMBOL MAP
const SYMBOLS = {
  NDQ: { av: "QQQ", fh: "QQQ", name: "NASDAQ 100", type: "index", base: 456 },
  US30: { av: "DIA", fh: "DIA", name: "Dow Jones 30", type: "index", base: 390 },
  SP500: { av: "SPY", fh: "SPY", name: "S&P 500", type: "index", base: 524 },
  GOLD: { av: "GLD", fh: "GLD", name: "Gold", type: "commodity", base: 216 },
  SILVER: { av: "SLV", fh: "SLV", name: "Silver", type: "commodity", base: 27 },
  GS: { av: "GS", fh: "GS", name: "Goldman Sachs", type: "stock", base: 458 },
  MS: { av: "MS", fh: "MS", name: "Morgan Stanley", type: "stock", base: 98 },
};

let marketCache = {};
let lastUpdated = null;
let refreshInProgress = false;
let refreshStatus = "Booting with sample market data";

function isFiniteNumber(value) {
  return Number.isFinite(toNumber(value));
}

function toNumber(value) {
  if (typeof value === "string") return parseFloat(value.replace("%", ""));
  return Number(value);
}

function round(value, digits = 2) {
  if (!isFiniteNumber(value)) return null;
  return Number(toNumber(value).toFixed(digits));
}

function getToday(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return date.toISOString().split("T")[0];
}

function normalizeQuote(raw) {
  if (!raw || !isFiniteNumber(raw.price)) return null;
  const price = round(raw.price);
  const open = round(raw.open ?? raw.prevClose ?? price);
  const high = round(raw.high ?? Math.max(price, open));
  const low = round(raw.low ?? Math.min(price, open));
  const prevClose = round(raw.prevClose ?? open);
  const change = round(raw.change ?? price - prevClose);
  const changePct = round(raw.changePct ?? (prevClose ? (change / prevClose) * 100 : 0));

  return {
    price,
    open,
    high,
    low,
    prevClose,
    change,
    changePct,
    volume: Math.max(0, Math.round(toNumber(raw.volume) || 0)),
  };
}

function seededWave(seed, index) {
  return Math.sin((index + 1) * (seed.length + 3) * 0.41) + Math.cos((index + 5) * 0.29);
}

function makeSampleBars(id, meta, days = 60) {
  let close = meta.base;
  const bars = [];

  for (let i = days - 1; i >= 0; i--) {
    const idx = days - i;
    const wave = seededWave(id, idx);
    const drift = meta.type === "commodity" ? 0.0008 : 0.0012;
    const pctMove = drift + wave * 0.006;
    const open = close;
    close = Math.max(1, close * (1 + pctMove));
    const high = Math.max(open, close) * (1 + Math.abs(wave) * 0.005 + 0.002);
    const low = Math.min(open, close) * (1 - Math.abs(wave) * 0.005 - 0.002);
    const volume = Math.round((meta.base * 90000) * (1 + Math.abs(wave) * 0.45));

    bars.push({
      date: getToday(-i),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
  }

  return bars;
}

function quoteFromBars(bars) {
  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2] || last;
  return normalizeQuote({
    price: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    prevClose: previous.close,
    change: last.close - previous.close,
    changePct: previous.close ? ((last.close - previous.close) / previous.close) * 100 : 0,
    volume: last.volume,
  });
}

function buildInstrument(id, meta, quote, bars, news, source, note) {
  const usableBars = Array.isArray(bars) && bars.length >= 26 ? bars : makeSampleBars(id, meta);
  const usableQuote = normalizeQuote(quote) || quoteFromBars(usableBars);
  const signal = generateSignal(usableQuote, usableBars, meta.type);

  if (note) signal.reasoning.unshift(note);

  return {
    id,
    name: meta.name,
    type: meta.type,
    quote: usableQuote,
    bars: usableBars.slice(-30),
    signal,
    news: news || [],
    source,
    updatedAt: new Date().toISOString(),
  };
}

function seedMarketCache() {
  marketCache = Object.fromEntries(
    Object.entries(SYMBOLS).map(([id, meta]) => {
      const bars = makeSampleBars(id, meta);
      return [id, buildInstrument(
        id,
        meta,
        quoteFromBars(bars),
        bars,
        [],
        "sample",
        "Sample data shown until the live provider responds"
      )];
    })
  );
  lastUpdated = new Date().toISOString();
}

async function fetchAVQuote(symbol) {
  if (!HAS_AV_KEY) return null;

  try {
    const url = "https://www.alphavantage.co/query";
    const { data } = await axios.get(url, {
      timeout: 8000,
      params: { function: "GLOBAL_QUOTE", symbol, apikey: AV_KEY },
    });
    const q = data["Global Quote"];
    if (!q || !q["05. price"]) return null;

    return normalizeQuote({
      price: q["05. price"],
      open: q["02. open"],
      high: q["03. high"],
      low: q["04. low"],
      prevClose: q["08. previous close"],
      change: q["09. change"],
      changePct: q["10. change percent"],
      volume: q["06. volume"],
    });
  } catch (e) {
    console.error(`AV quote error for ${symbol}:`, e.message);
    return null;
  }
}

async function fetchAVDaily(symbol) {
  if (!HAS_AV_KEY) return [];

  try {
    const url = "https://www.alphavantage.co/query";
    const { data } = await axios.get(url, {
      timeout: 10000,
      params: {
        function: "TIME_SERIES_DAILY",
        symbol,
        outputsize: "compact",
        apikey: AV_KEY,
      },
    });
    const ts = data["Time Series (Daily)"];
    if (!ts) return [];

    return Object.entries(ts)
      .slice(0, 60)
      .map(([date, v]) => ({
        date,
        open: round(v["1. open"]),
        high: round(v["2. high"]),
        low: round(v["3. low"]),
        close: round(v["4. close"]),
        volume: parseInt(v["5. volume"], 10) || 0,
      }))
      .filter(bar => isFiniteNumber(bar.close))
      .reverse();
  } catch (e) {
    console.error(`AV daily error for ${symbol}:`, e.message);
    return [];
  }
}

async function fetchFHQuote(symbol) {
  if (!HAS_FH_KEY) return null;

  try {
    const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
      timeout: 8000,
      params: { symbol, token: FH_KEY },
    });
    if (!data || !isFiniteNumber(data.c) || toNumber(data.c) <= 0) return null;

    return normalizeQuote({
      price: data.c,
      open: data.o,
      high: data.h,
      low: data.l,
      prevClose: data.pc,
      change: toNumber(data.c) - toNumber(data.pc || data.o || data.c),
      changePct: data.dp,
      volume: 0,
    });
  } catch (e) {
    console.error(`Finnhub quote error for ${symbol}:`, e.message);
    return null;
  }
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return round(ema, 4);
}

function getSeasonalBias(type) {
  const month = new Date().getMonth();
  const indexBias = [0.6, 0.5, 0.55, 0.6, 0.45, 0.4, 0.5, 0.55, 0.45, 0.6, 0.65, 0.7];
  const goldBias = [0.6, 0.55, 0.5, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.6, 0.55, 0.6];
  const stockBias = [0.55, 0.5, 0.55, 0.6, 0.5, 0.45, 0.55, 0.6, 0.5, 0.65, 0.65, 0.65];
  if (type === "commodity") return goldBias[month];
  if (type === "stock") return stockBias[month];
  return indexBias[month];
}

function generateSignal(quote, bars, type) {
  if (!quote || !Array.isArray(bars) || bars.length < 26) {
    return { signal: "NEUTRAL", confidence: 50, reasoning: ["Insufficient data"] };
  }

  const closes = bars.map(b => b.close).filter(isFiniteNumber);
  const volumes = bars.map(b => toNumber(b.volume) || 0);
  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 || 1;
  const lastVol = volumes[volumes.length - 1] || avgVol;
  const volRatio = lastVol / avgVol;
  const seasonal = getSeasonalBias(type);

  let score = 0;
  const reasoning = [];

  if (rsi !== null) {
    if (rsi < 35) {
      score += 1.5;
      reasoning.push(`RSI ${rsi} - oversold, bullish bias`);
    } else if (rsi < 45) {
      score += 0.5;
      reasoning.push(`RSI ${rsi} - approaching oversold`);
    } else if (rsi > 65) {
      score -= 1.5;
      reasoning.push(`RSI ${rsi} - overbought, bearish bias`);
    } else if (rsi > 55) {
      score -= 0.5;
      reasoning.push(`RSI ${rsi} - approaching overbought`);
    } else {
      reasoning.push(`RSI ${rsi} - neutral zone`);
    }
  }

  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) {
      score += 1;
      reasoning.push("EMA 9 above EMA 21 - bullish trend");
    } else {
      score -= 1;
      reasoning.push("EMA 9 below EMA 21 - bearish trend");
    }
  }

  if (volRatio > 1.5) {
    score += 0.5;
    reasoning.push(`Volume ${volRatio.toFixed(1)}x avg - strong momentum`);
  } else if (volRatio < 0.6) {
    score -= 0.3;
    reasoning.push("Volume low - weak conviction");
  }

  if (quote.price > quote.open) {
    score += 0.3;
    reasoning.push("Price above open - intraday strength");
  } else {
    score -= 0.3;
    reasoning.push("Price below open - intraday weakness");
  }

  const month = new Date().toLocaleString("default", { month: "long" });
  if (seasonal > 0.58) {
    score += 0.5;
    reasoning.push(`Seasonal bias bullish for ${month}`);
  } else if (seasonal < 0.47) {
    score -= 0.5;
    reasoning.push(`Seasonal bias bearish for ${month}`);
  }

  let signal;
  let confidence;
  if (score > 2) {
    signal = "STRONG BUY";
    confidence = Math.min(90, 65 + score * 5);
  } else if (score > 0.5) {
    signal = "BUY";
    confidence = Math.min(75, 55 + score * 7);
  } else if (score < -2) {
    signal = "STRONG SELL";
    confidence = Math.min(90, 65 + Math.abs(score) * 5);
  } else if (score < -0.5) {
    signal = "SELL";
    confidence = Math.min(75, 55 + Math.abs(score) * 7);
  } else {
    signal = "NEUTRAL";
    confidence = 50;
  }

  return {
    signal,
    confidence: Math.round(confidence),
    rsi,
    ema9: ema9?.toFixed(2),
    ema21: ema21?.toFixed(2),
    volRatio: volRatio.toFixed(2),
    seasonal: `${(seasonal * 100).toFixed(0)}%`,
    reasoning,
    score: round(score),
  };
}

async function fetchNews(symbol) {
  if (!HAS_FH_KEY) return [];

  try {
    const { data } = await axios.get("https://finnhub.io/api/v1/company-news", {
      timeout: 8000,
      params: {
        symbol,
        from: getToday(-7),
        to: getToday(),
        token: FH_KEY,
      },
    });

    return (data || []).slice(0, 4).map(n => ({
      headline: n.headline,
      source: n.source,
      url: n.url,
      sentiment: n.sentiment || null,
    }));
  } catch (e) {
    console.error(`News error for ${symbol}:`, e.message);
    return [];
  }
}

async function refreshOne(id, meta) {
  const [fhQuote, news] = await Promise.all([
    fetchFHQuote(meta.fh),
    fetchNews(meta.fh),
  ]);

  const avBars = await fetchAVDaily(meta.av);
  const avQuote = fhQuote ? null : await fetchAVQuote(meta.av);
  const liveQuote = fhQuote || avQuote;
  const existing = marketCache[id];
  const bars = avBars.length ? avBars : existing?.bars;
  const quote = liveQuote || existing?.quote;
  const source = liveQuote || avBars.length ? "live" : "sample";
  const note = source === "live"
    ? "Live quote/data provider connected"
    : "Live provider unavailable; sample technicals remain visible";

  marketCache[id] = buildInstrument(id, meta, quote, bars, news, source, note);
}

async function refreshMarketData() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  refreshStatus = "Refreshing live market data";
  console.log("[refresh] Fetching market data...");

  try {
    const entries = Object.entries(SYMBOLS);

    // Alpha Vantage's free tier is tight, so live upgrades are staggered in the
    // background while the app keeps serving the seeded snapshot immediately.
    for (let i = 0; i < entries.length; i++) {
      const [id, meta] = entries[i];
      if (HAS_AV_KEY && i > 0) await new Promise(resolve => setTimeout(resolve, 13000));
      await refreshOne(id, meta);
    }

    lastUpdated = new Date().toISOString();
    refreshStatus = "Live refresh complete";
    console.log("[refresh] Done.");
  } catch (e) {
    refreshStatus = "Refresh failed; showing last known snapshot";
    console.error("[refresh] Failed:", e.message);
  } finally {
    refreshInProgress = false;
  }
}

seedMarketCache();

app.get("/api/market", (req, res) => {
  res.json({
    data: marketCache,
    lastUpdated,
    refreshInProgress,
    status: refreshStatus,
    providers: {
      alphaVantage: HAS_AV_KEY,
      finnhub: HAS_FH_KEY,
    },
  });
});

app.get("/api/market/:id", (req, res) => {
  const id = req.params.id.toUpperCase();
  if (!marketCache[id]) return res.status(404).json({ error: "Symbol not found" });
  res.json(marketCache[id]);
});

app.post("/api/refresh", (req, res) => {
  refreshMarketData();
  res.json({ message: "Refresh triggered", refreshInProgress: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", lastUpdated, refreshInProgress, refreshStatus });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshMarketData();
  setInterval(refreshMarketData, 5 * 60 * 1000);
});
