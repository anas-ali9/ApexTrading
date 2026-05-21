// Trading Dashboard Server
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
const FOREX_COM_NEWS_URL = process.env.FOREX_COM_NEWS_URL || "https://www.forex.com/en-us/news-and-analysis/";

const HAS_AV_KEY = Boolean(AV_KEY && AV_KEY !== "demo" && AV_KEY !== "your_key_here");
const HAS_FH_KEY = Boolean(FH_KEY && FH_KEY !== "your_key_here");

// SYMBOL MAP
const SYMBOLS = {
  NDQ: {
    av: "QQQ",
    fh: "QQQ",
    name: "NASDAQ 100",
    type: "index",
    base: 456,
    newsKeywords: ["nasdaq", "nasdaq 100", "us tech 100", "tech", "qqq", "megacap", "nvidia", "apple", "microsoft"],
  },
  US30: {
    av: "DIA",
    fh: "DIA",
    name: "Dow Jones 30",
    type: "index",
    base: 390,
    newsKeywords: ["dow", "dow jones", "wall street", "industrial", "us 30", "dia", "blue chip"],
  },
  SP500: {
    av: "SPY",
    fh: "SPY",
    name: "S&P 500",
    type: "index",
    base: 524,
    newsKeywords: ["s&p", "s&p 500", "spx", "spy", "us 500", "wall street", "stocks", "equities"],
  },
  GOLD: {
    av: "GLD",
    fh: "GLD",
    name: "Gold",
    type: "commodity",
    base: 216,
    newsKeywords: ["gold", "xau", "xau/usd", "xauusd", "bullion", "precious metal", "gld"],
  },
  SILVER: {
    av: "SLV",
    fh: "SLV",
    name: "Silver",
    type: "commodity",
    base: 27,
    newsKeywords: ["silver", "xag", "xag/usd", "xagusd", "precious metal", "slv"],
  },
  GS: {
    av: "GS",
    fh: "GS",
    name: "Goldman Sachs",
    type: "stock",
    base: 458,
    newsKeywords: ["goldman", "goldman sachs", "gs", "banks", "banking", "financials", "wall street"],
  },
  MS: {
    av: "MS",
    fh: "MS",
    name: "Morgan Stanley",
    type: "stock",
    base: 98,
    newsKeywords: ["morgan stanley", "ms", "banks", "banking", "financials", "wall street"],
  },
};

let marketCache = {};
let lastUpdated = null;
let refreshInProgress = false;
let refreshStatus = "Booting with sample market data";
let forexComCache = { articles: [], fetchedAt: 0 };

const FOREX_COM_FALLBACK_ARTICLES = [
  {
    headline: "Nasdaq 100 forecast: Sentiment hurt as yields surge",
    url: "https://www.forex.com/en-us/news-and-analysis/nasdaq-100-forecast-sentiment-hurt-as-yields-surge/",
    keywords: ["nasdaq", "nasdaq 100", "tech", "yields", "stocks"],
  },
  {
    headline: "USDJPY, Dow Jones Forecast: Rising Bond Yields Push USDJPY Toward 160, Dow Jones Struggles",
    url: "https://www.forex.com/en-us/news-and-analysis/usdjpy-dow-jones-forecast-rising-bond-yields-push-usdjpy-toward-160-dow-jones-struggles/",
    keywords: ["dow", "dow jones", "yields", "dollar", "stocks"],
  },
  {
    headline: "S&P 500 Hits Records Even as Bond Yields and Oil Prices Climb",
    url: "https://www.forex.com/en-us/news-and-analysis/sandp-500-hits-records-even-as-bond-yields-and-oil-prices-climb/",
    keywords: ["s&p", "s&p 500", "spx", "stocks", "yields", "oil"],
  },
  {
    headline: "S&P 500 Analysis: SPX reaches 7,500 points amid optimism over the US-China meeting",
    url: "https://www.forex.com/en-us/news-and-analysis/sp-500-analysis-spx-reaches-7500-points-amid-optimism-over-the-us-china-meeting/",
    keywords: ["s&p", "s&p 500", "spx", "stocks"],
  },
  {
    headline: "Gold forecast undermined as oil, yields and dollar apply pressure",
    url: "https://www.forex.com/en-us/news-and-analysis/gold-forecast-undermined-as-oil-yields-and-dollar-apply-pressure/",
    keywords: ["gold", "xau", "dollar", "yields", "inflation"],
  },
  {
    headline: "USD Majors, Gold, Oil, Bitcoin, Equities Weekly Technical Outlook",
    url: "https://www.forex.com/en-us/news-and-analysis/usd-majors-gold-oil-bitcoin-equities-weekly-technical-outlook-5-18-2026/",
    keywords: ["gold", "equities", "stocks", "technical", "dollar", "oil"],
  },
  {
    headline: "Crude Oil, Nasdaq Outlook: Oil Near $100, Nasdaq Eyes 30,000 as Markets Watch Cerebras IPO and Geopolitics",
    url: "https://www.forex.com/en-us/news-and-analysis/crude-oil-nasdaq-outlook-oil-near-100-nasdaq-eyes-30-000-as-markets-watch-cerebras-ipo-and-geopolitics/",
    keywords: ["nasdaq", "tech", "oil", "stocks"],
  },
  {
    headline: "Bitcoin & Dow Jones Slow Near Key Resistance as Inflation Pressures Build",
    url: "https://www.forex.com/en-us/news-and-analysis/bitcoin-and-dow-jones-slow-near-key-resistance-as-inflation-pressures-build/",
    keywords: ["dow", "dow jones", "inflation", "resistance", "stocks"],
  },
].map(article => ({
  ...article,
  summary: article.keywords.join(" "),
  source: "FOREX.com",
  fallback: true,
}));

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

function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<[^>]*>/g, " "));
}

function absoluteForexUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return new URL(url, "https://www.forex.com").toString();
}

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = (item.url || item.headline || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const forexCount = (news || []).filter(item => item.source === "FOREX.com").length;
  if (forexCount) {
    signal.reasoning.push(`${forexCount} FOREX.com analysis item${forexCount > 1 ? "s" : ""} matched this market`);
  }

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
      summary: "",
      sentiment: n.sentiment || null,
      relevance: "Company headline",
      analysis: "Finnhub company/news feed",
    }));
  } catch (e) {
    console.error(`News error for ${symbol}:`, e.message);
    return [];
  }
}

function parseForexComHtml(html) {
  const articles = [];
  const cardRegex = /<a[^>]+href=["']([^"']*\/news-and-analysis\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = cardRegex.exec(html))) {
    const url = absoluteForexUrl(match[1]);
    const text = stripTags(match[2]);
    if (!text || text.length < 18 || text.length > 260) continue;
    if (/\/tags\/|\/market-analysis\/?$|\/news-and-analysis\/?$/i.test(url)) continue;
    if (/news and analysis|learn to trade|open an account/i.test(text)) continue;

    articles.push({
      headline: text,
      summary: "",
      source: "FOREX.com",
      url,
    });
  }

  const titleRegex = /<title>(.*?)<\/title>/i;
  const title = titleRegex.exec(html)?.[1];
  if (title && /market|analysis|forex|gold|stocks|indices/i.test(title)) {
    articles.unshift({
      headline: stripTags(title.replace(/\|.*$/g, "")),
      summary: "",
      source: "FOREX.com",
      url: FOREX_COM_NEWS_URL,
    });
  }

  return uniqueByUrl(articles).slice(0, 30);
}

async function fetchForexComFromReddit() {
  try {
    const { data } = await axios.get("https://www.reddit.com/user/FOREXcom/submitted.json", {
      timeout: 8000,
      headers: { "User-Agent": "ApexTradeDashboard/1.0" },
      params: { limit: 25 },
    });

    return (data?.data?.children || [])
      .map(item => item.data)
      .filter(post => post?.title && /forex\.com/i.test(post.url || ""))
      .map(post => ({
        headline: post.title,
        summary: post.selftext || "",
        source: "FOREX.com",
        url: post.url,
      }));
  } catch (e) {
    console.error("FOREX.com Reddit fallback error:", e.message);
    return [];
  }
}

async function fetchForexComArticles() {
  const cacheAgeMs = Date.now() - forexComCache.fetchedAt;
  if (forexComCache.articles.length && cacheAgeMs < 5 * 60 * 1000) {
    return forexComCache.articles;
  }

  const urls = uniqueByUrl([
    { url: FOREX_COM_NEWS_URL },
    { url: "https://www.forex.com/en-us/news-and-analysis/" },
    { url: "https://www.forex.com/en/news-and-analysis/" },
    { url: "https://qa-web.forex.com/en-us/news-and-analysis/" },
  ]).map(item => item.url);

  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 ApexTradeDashboard/1.0",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      const articles = parseForexComHtml(data);
      if (articles.length) {
        forexComCache = { articles, fetchedAt: Date.now() };
        return articles;
      }
    } catch (e) {
      console.error(`FOREX.com news error for ${url}:`, e.message);
    }
  }

  const fallback = uniqueByUrl([
    ...await fetchForexComFromReddit(),
    ...FOREX_COM_FALLBACK_ARTICLES,
  ]);
  forexComCache = { articles: fallback, fetchedAt: Date.now() };
  return fallback;
}

function analyzeNewsForSymbol(item, meta) {
  const text = `${item.headline || ""} ${item.summary || ""}`.toLowerCase();
  const directMatches = (meta.newsKeywords || []).filter(keyword => text.includes(keyword.toLowerCase()));
  const macroKeywords = ["fed", "rates", "inflation", "cpi", "pce", "payrolls", "dollar", "yields", "treasury", "risk", "recession"];
  const macroMatches = macroKeywords.filter(keyword => text.includes(keyword));

  let relevanceScore = directMatches.length * 3 + macroMatches.length;
  if (item.source === "FOREX.com") relevanceScore += 1;
  if (meta.type === "index" && /stocks|equities|wall street|nasdaq|s&p|dow/i.test(text)) relevanceScore += 2;
  if (meta.type === "commodity" && /gold|silver|xau|xag|dollar|yields|inflation/i.test(text)) relevanceScore += 2;
  if (meta.type === "stock" && /bank|banks|financial|earnings|wall street/i.test(text)) relevanceScore += 2;

  const bullishWords = ["bullish", "rally", "breakout", "higher", "gain", "surge", "support", "record", "rebound"];
  const bearishWords = ["bearish", "selloff", "lower", "drop", "risk", "pressure", "resistance", "weak", "falls"];
  const bullish = bullishWords.filter(word => text.includes(word)).length;
  const bearish = bearishWords.filter(word => text.includes(word)).length;
  const tone = bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "mixed";

  return {
    ...item,
    sentiment: item.sentiment || tone,
    relevanceScore,
    relevance: directMatches.length
      ? `Matched ${directMatches.slice(0, 3).join(", ")}`
      : macroMatches.length
        ? `Macro context: ${macroMatches.slice(0, 3).join(", ")}`
        : "General market context",
    analysis: `${tone.toUpperCase()} read - ${relevanceScore >= 5 ? "high" : relevanceScore >= 3 ? "medium" : "light"} relevance`,
  };
}

async function fetchRelevantNews(symbol, meta) {
  const [finnhubNews, forexArticles] = await Promise.all([
    fetchNews(symbol),
    fetchForexComArticles(),
  ]);

  const scored = uniqueByUrl([...forexArticles, ...FOREX_COM_FALLBACK_ARTICLES, ...finnhubNews])
    .map(item => analyzeNewsForSymbol(item, meta))
    .filter(item => item.source !== "FOREX.com" || item.relevanceScore >= 2)
    .sort((a, b) => {
      if (a.source === "FOREX.com" && b.source !== "FOREX.com") return -1;
      if (a.source !== "FOREX.com" && b.source === "FOREX.com") return 1;
      return b.relevanceScore - a.relevanceScore;
    });

  return uniqueByUrl(scored).slice(0, 6);
}

async function refreshOne(id, meta) {
  const [fhQuote, news] = await Promise.all([
    fetchFHQuote(meta.fh),
    fetchRelevantNews(meta.fh, meta),
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
  res.json({
    status: "ok",
    lastUpdated,
    refreshInProgress,
    refreshStatus,
    providers: {
      alphaVantage: HAS_AV_KEY,
      finnhub: HAS_FH_KEY,
      forexCom: Boolean(FOREX_COM_NEWS_URL),
    },
    cachedSymbols: Object.keys(marketCache).length,
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshMarketData();
  setInterval(refreshMarketData, 5 * 60 * 1000);
});
