# APEXTRADE — AI Trading Dashboard

A live trading signals dashboard with AI-powered technical + fundamental analysis.
Covers NDQ, US30, SP500, Gold, Silver, GS, MS — with RSI, EMA, volume, seasonal analysis.

---

## 🚀 Deploy to Railway (5 minutes)

### Step 1 — Get free API keys (takes 2 minutes)
| Key | Where | Free Limit |
|-----|-------|------------|
| **Alpha Vantage** | https://alphavantage.co/support/#api-key | 25 req/day, 5/min |
| **Finnhub** | https://finnhub.io/register | 60 req/min |

### Step 2 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial APEXTRADE deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/apextrade.git
git push -u origin main
```

### Step 3 — Deploy on Railway
1. Go to https://railway.app → **New Project → Deploy from GitHub repo**
2. Select your repo
3. Click **Variables** tab → add:
   - `ALPHA_VANTAGE_KEY` = your key
   - `FINNHUB_KEY` = your key
4. Railway auto-deploys. Your live URL appears in ~60 seconds.

### Step 4 — Verify
- Visit `https://your-app.railway.app/health` → should return `{"status":"ok"}`
- Main dashboard: `https://your-app.railway.app`

---

## 📁 Project Structure
```
trading-app/
├── server.js          ← Express backend + AI signal engine
├── package.json
├── railway.toml       ← Railway deploy config
├── .env.example       ← Copy to .env locally
└── public/
    └── index.html     ← Full trading dashboard frontend
```

---

## 🧠 AI Signal Engine (server.js)
Combines 5 confluences into a BUY / SELL / NEUTRAL signal with confidence %:

| Confluence | Weight |
|------------|--------|
| RSI-14 (oversold/overbought) | High |
| EMA 9/21 crossover | High |
| Volume ratio (vs 20-day avg) | Medium |
| Price vs open (intraday bias) | Low |
| Seasonal bias (monthly tendency) | Low |

Score range: **-4 to +4**  
→ > 2: STRONG BUY | > 0.5: BUY | < -2: STRONG SELL | < -0.5: SELL | else: NEUTRAL

---

## ⚠️ Important Notes

- **Alpha Vantage free tier = 25 requests/day** → covers ~3 full refreshes of all 7 symbols
- For more frequent updates, upgrade to a paid AV plan (~$50/mo) or swap to a different data provider
- The `demo` API key (default) only works for IBM stock — replace it to see real data
- Data refreshes every **5 minutes** server-side

---

## 🔜 Next Steps (tell Claude what you want)
- [ ] Add more symbols
- [ ] Broker integration (Alpaca, Interactive Brokers)
- [ ] User login + watchlists
- [ ] TradingView chart embeds
- [ ] OpenAI GPT-4 for richer signal narration
- [ ] Mobile push notifications for strong signals
- [ ] Custom UI theme / color scheme
