/**
 * Funding Radar v11
 * Full CMC integration: listings, gainers, losers, trending, new coins, coin info
 * TradingView charts for each coin detail
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'funding-radar-v11-secret';
const CMC_KEY = () => process.env.CMC_API_KEY || '93ef6204acea47a7b2d2c1a18928e2c9';
const CMC = 'https://pro-api.coinmarketcap.com/v1';

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = {};
const TTL = { funding: 60_000, market: 180_000, news: 300_000, trending: 120_000, info: 3600_000 };
function getCache(k) { const e = cache[k]; if (e && Date.now() - e.ts < (TTL[e.type] || 60_000)) return e.data; return null; }
function setCache(k, d, type = 'funding') { cache[k] = { data: d, ts: Date.now(), type }; }

// ── Auth ──────────────────────────────────────────────────────────────────────
function b64url(s) { return Buffer.from(s).toString('base64url'); }
function signJWT(p) { const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), pay = b64url(JSON.stringify({ ...p, iat: Math.floor(Date.now() / 1000) })), sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pay}`).digest('base64url'); return `${h}.${pay}.${sig}`; }
function verifyJWT(t) { try { const [h, p, sig] = t.split('.'); if (sig !== crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')) return null; return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; } }
function auth(req, res, next) { const t = req.headers.authorization?.replace('Bearer ', ''); if (!t) return res.status(401).json({ ok: false, error: 'No token' }); const p = verifyJWT(t); if (!p) return res.status(401).json({ ok: false, error: 'Invalid token' }); req.user = p; next(); }
const users = new Map();
function hashPw(pw) { return crypto.createHash('sha256').update(pw + JWT_SECRET).digest('hex'); }

// ── Resend Email ──────────────────────────────────────────────────────────────
const RESEND_API_KEY = () => process.env.RESEND_API_KEY;
const FROM_EMAIL = () => process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://funding-radar-production.up.railway.app';

async function sendEmail({ to, subject, html, text }) {
  const key = RESEND_API_KEY();
  if (!key) throw new Error('RESEND_API_KEY not set in Railway Variables');
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Funding Radar <${FROM_EMAIL()}>`,
      to: [to],
      subject,
      html,
      text: text || subject,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${data?.message || JSON.stringify(data)}`);
  console.log(`[Email] ✓ Sent to ${to} via Resend (id: ${data.id})`);
  return true;
}

// Reset token store: email → { token, expires }
const resetTokens = new Map();

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function resetEmailHTML(name, resetUrl) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#161b22;border-radius:16px;border:1px solid #2a3f5f;overflow:hidden;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#58a6ff,#bc8cff);padding:32px;text-align:center;">
      <div style="width:60px;height:60px;background:rgba(0,0,0,0.2);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <span style="color:#000;font-size:24px;font-weight:900;font-family:monospace;">FR</span>
      </div>
      <h1 style="color:#000;margin:0;font-size:24px;font-weight:900;letter-spacing:-0.5px;">Funding Radar</h1>
      <p style="color:rgba(0,0,0,0.7);margin:4px 0 0;font-size:13px;">Live Crypto Intelligence</p>
    </div>
    <!-- Body -->
    <div style="padding:32px;">
      <h2 style="color:#e6edf3;margin:0 0 8px;font-size:20px;">Password Reset Request</h2>
      <p style="color:#b0c0d8;line-height:1.6;margin:0 0 24px;">
        Hi <strong style="color:#e6edf3;">${name}</strong>,<br/><br/>
        We received a request to reset your Funding Radar password. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#58a6ff,#bc8cff);color:#000;font-weight:900;font-size:16px;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:0.3px;">
          Reset My Password →
        </a>
      </div>
      <div style="background:#0d1117;border:1px solid #2a3f5f;border-radius:8px;padding:14px;margin:20px 0;">
        <p style="color:#6e8aaa;font-size:12px;margin:0 0 6px;font-family:monospace;letter-spacing:0.5px;">OR COPY THIS LINK:</p>
        <p style="color:#58a6ff;font-size:12px;margin:0;word-break:break-all;font-family:monospace;">${resetUrl}</p>
      </div>
      <p style="color:#6e8aaa;font-size:13px;line-height:1.6;margin:20px 0 0;">
        If you did not request a password reset, please ignore this email. Your account is safe.<br/><br/>
        This link will expire in <strong>1 hour</strong>.
      </p>
    </div>
    <!-- Footer -->
    <div style="padding:20px 32px;border-top:1px solid #2a3f5f;text-align:center;">
      <p style="color:#6e8aaa;font-size:12px;margin:0;font-family:monospace;">
        © ${new Date().getFullYear()} Funding Radar · For informational purposes only
      </p>
    </div>
  </div>
</body>
</html>`;
}

function resetSuccessHTML(name) {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#161b22;border-radius:16px;border:1px solid #2a3f5f;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#23d18b,#58a6ff);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:8px;">✅</div>
      <h1 style="color:#000;margin:0;font-size:22px;font-weight:900;">Password Changed!</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#b0c0d8;line-height:1.6;">
        Hi <strong style="color:#e6edf3;">${name}</strong>,<br/><br/>
        Your Funding Radar password has been successfully changed. You can now sign in with your new password.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${FRONTEND_URL()}" style="display:inline-block;background:linear-gradient(135deg,#58a6ff,#bc8cff);color:#000;font-weight:900;font-size:16px;padding:14px 32px;border-radius:10px;text-decoration:none;">
          Go to Funding Radar →
        </a>
      </div>
      <p style="color:#6e8aaa;font-size:13px;">If you did not make this change, please contact support immediately.</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchJSON(url, opts = {}, retries = 2, ms = 15000) {
  const { default: fetch } = await import('node-fetch');
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), ms);
      const res = await fetch(url, { signal: ctrl.signal, method: opts.method || 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', ...opts.headers }, body: opts.body });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; if (i < retries) await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw new Error(`${url} => ${last?.message}`);
}
async function fetchText(url) {
  const { default: fetch } = await import('node-fetch');
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 10000);
  const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
  clearTimeout(t); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text();
}
async function postJSON(url, body) { return fetchJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
function cmcFetch(path) { return fetchJSON(`${CMC}${path}`, { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY(), 'Accept': 'application/json' } }, 2, 15000); }

function toMs(ts, fallH = 8) {
  if (!ts) return Date.now() + fallH * 3_600_000;
  const n = Number(ts), ms = n < 9_999_999_999 ? n * 1000 : n, now = Date.now();
  return (ms > now && ms < now + 25 * 3_600_000) ? ms : Date.now() + fallH * 3_600_000;
}

// ═══════════════════ EXCHANGES ════════════════════════════════════════════════
async function fetchBinance() {
  const c = getCache('binance'); if (c) return c;
  const BASES = ['https://fapi.binance.com', 'https://api4.binance.com', 'https://api1.binance.com'];
  let prem = null, base = '';
  for (const b of BASES) { try { prem = await fetchJSON(`${b}/fapi/v1/premiumIndex`, {}, 1, 9000); if (prem?.length) { base = b; break; } } catch (e) { console.log(`[Binance] ${b}: ${e.message}`); } }
  if (!prem?.length) throw new Error('Binance: all mirrors failed');
  let iv = []; try { iv = await fetchJSON(`${base}/fapi/v1/fundingInfo`, {}, 1, 8000); } catch {}
  const ivMap = {}; (Array.isArray(iv) ? iv : []).forEach(d => { if (d.symbol && d.fundingIntervalHours) ivMap[d.symbol] = Number(d.fundingIntervalHours); });
  const r = prem.filter(d => d.symbol?.endsWith('USDT')).map(d => ({ ex: 'binance', sym: d.symbol.replace('USDT', ''), pair: d.symbol, rate: parseFloat(d.lastFundingRate) || 0, next: toMs(d.nextFundingTime, ivMap[d.symbol] || 8), price: parseFloat(d.markPrice) || 0, iv: ivMap[d.symbol] || 8 }));
  setCache('binance', r); console.log(`[Binance] ✓ ${r.length}`); return r;
}
async function fetchBybit() {
  const c = getCache('bybit'); if (c) return c;
  const BASES = ['https://api.bybit.com', 'https://api.bytick.com'];
  let all = [], ok = false;
  for (const b of BASES) {
    try {
      let cur = '', pg = 0, rows = [];
      do { const d = await fetchJSON(`${b}/v5/market/tickers?category=linear&limit=1000${cur ? '&cursor=' + encodeURIComponent(cur) : ''}`, {}, 1, 10000); rows.push(...(d?.result?.list || [])); cur = d?.result?.nextPageCursor || ''; pg++; } while (cur && pg < 10);
      if (rows.length) { all = rows; ok = true; break; }
    } catch (e) { console.log(`[Bybit] ${b}: ${e.message}`); }
  }
  if (!ok) throw new Error('Bybit: all mirrors failed');
  const r = all.filter(d => d.symbol?.endsWith('USDT') && d.fundingRate != null && d.fundingRate !== '').map(d => {
    const next = Number(d.nextFundingTime) || 0, last = Number(d.fundingRateTimestamp) || 0;
    let iv = 8; if (next > 0 && last > 0) { const h = (next - last) / 3600000; if (h >= 0.9 && h <= 24) iv = Math.round(h); }
    return { ex: 'bybit', sym: d.symbol.replace('USDT', ''), pair: d.symbol, rate: parseFloat(d.fundingRate) || 0, next: toMs(next, iv), price: parseFloat(d.markPrice) || 0, iv };
  });
  setCache('bybit', r); console.log(`[Bybit] ${r.length}`); return r;
}
async function fetchBitget() {
  const c = getCache('bitget'); if (c) return c;

  // Fetch all three endpoints in parallel:
  // 1. tickers — fundingRate + price (nextFundingTime NOT reliable here)
  // 2. contracts — fundInterval (real hours per symbol)
  // 3. funding-time bulk — nextFundingTime in ms (this is the accurate source)
  const [tickers, contracts, fundingTimes] = await Promise.all([
    fetchJSON('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'),
    fetchJSON('https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures').catch(() => ({ data: [] })),
    // funding-time WITHOUT symbol param returns ALL symbols at once
    fetchJSON('https://api.bitget.com/api/v2/mix/market/batch-symbol-next-funding-time?productType=usdt-futures').catch(() => ({ data: [] })),
  ]);

  // Interval map: symbol -> hours
  const ivMap = {};
  (contracts?.data || []).forEach(d => {
    if (d.symbol && d.fundInterval) ivMap[d.symbol] = Number(d.fundInterval) || 8;
  });

  // Next funding time map: symbol -> ms timestamp (string in API, convert to number)
  const nextMap = {};
  (fundingTimes?.data || []).forEach(d => {
    if (d.symbol && d.nextFundingTime) {
      nextMap[d.symbol] = Number(d.nextFundingTime); // already in ms per Bitget docs
    }
  });

  const now = Date.now();
  const r = (tickers?.data || [])
    .filter(d => d.fundingRate != null && d.fundingRate !== '')
    .map(d => {
      const sym = d.symbol
        .replace(/USDT_UMCBL$/i, '').replace(/USDT$/i, '').replace(/_UMCBL$/i, '')
        .toUpperCase();
      const iv = ivMap[d.symbol] || 8;

      // Use batch funding time map first (most accurate), fallback to calculated
      let next = nextMap[d.symbol] || 0;

      // Validate: must be future ms within 25h
      if (!next || next <= now || next > now + 25 * 3_600_000) {
        // Calculate next funding time based on interval
        // Bitget funding times are on round hours: 0:00, 8:00, 16:00 UTC (for 8h)
        const msPerInterval = iv * 3_600_000;
        const cycleStart = Math.floor(now / msPerInterval) * msPerInterval;
        next = cycleStart + msPerInterval;
      }

      return {
        ex: 'bitget', sym, pair: d.symbol,
        rate: parseFloat(d.fundingRate) || 0,
        next,
        price: parseFloat(d.markPrice || d.lastPr || d.close) || 0,
        iv,
      };
    })
    .filter(d => d.sym.length > 0);

  setCache('bitget', r);
  const sample = r.find(x => x.sym === 'BTC') || r[0];
  console.log(`[Bitget] ${r.length} symbols | BTC next: ${sample ? new Date(sample.next).toUTCString() : 'n/a'} | nextMap size: ${Object.keys(nextMap).length}`);
  return r;
}
async function fetchGate() {
  const c = getCache('gate'); if (c) return c;
  const BASE = 'https://api.gateio.ws/api/v4';
  const [tickers, contracts] = await Promise.all([fetchJSON(`${BASE}/futures/usdt/tickers`), fetchJSON(`${BASE}/futures/usdt/contracts`)]);
  const meta = {}; (contracts || []).forEach(c => { meta[c.name] = { next: c.funding_next_apply ? Number(c.funding_next_apply) * 1000 : 0, iv: c.funding_interval ? Math.max(1, Math.round(Number(c.funding_interval) / 3600)) : 8 }; });
  const r = (tickers || []).filter(d => d.contract?.endsWith('_USDT') && d.funding_rate != null).map(d => { const m = meta[d.contract] || {}; return { ex: 'gate', sym: d.contract.replace('_USDT', ''), pair: d.contract, rate: parseFloat(d.funding_rate) || 0, next: toMs(m.next, m.iv || 8), price: parseFloat(d.last) || 0, iv: m.iv || 8 }; });
  setCache('gate', r); console.log(`[Gate.io] ${r.length}`); return r;
}
async function fetchHyperliquid() {
  const c = getCache('hyperliquid'); if (c) return c;
  const data = await postJSON('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
  if (!Array.isArray(data) || data.length < 2) throw new Error('Hyperliquid: bad response');
  const [meta, ctxs] = data; const universe = meta?.universe || [];
  const now = Date.now(), nextHour = now + (3600000 - (now % 3600000));
  const r = universe.map((a, i) => { const ctx = ctxs[i]; if (!ctx || !a?.name || a.name.includes(':')) return null; return { ex: 'hyperliquid', sym: a.name.toUpperCase(), pair: a.name + '-PERP', rate: parseFloat(ctx.funding) || 0, next: nextHour, price: parseFloat(ctx.markPx) || 0, iv: 1 }; }).filter(Boolean);
  setCache('hyperliquid', r); console.log(`[Hyperliquid] ${r.length}`); return r;
}

// ═══════════════════ CMC MARKET DATA ══════════════════════════════════════════
function normalizeCMC(c) {
  return {
    id: c.id, name: c.name, symbol: c.symbol, rank: c.cmc_rank,
    slug: c.slug,
    image: `https://s2.coinmarketcap.com/static/img/coins/64x64/${c.id}.png`,
    current_price: c.quote?.USD?.price || 0,
    market_cap: c.quote?.USD?.market_cap || 0,
    total_volume: c.quote?.USD?.volume_24h || 0,
    price_change_percentage_1h_in_currency: c.quote?.USD?.percent_change_1h || 0,
    price_change_percentage_24h: c.quote?.USD?.percent_change_24h || 0,
    price_change_percentage_7d_in_currency: c.quote?.USD?.percent_change_7d || 0,
    circulating_supply: c.circulating_supply || 0,
    max_supply: c.max_supply || 0,
    total_supply: c.total_supply || 0,
    market_cap_rank: c.cmc_rank,
  };
}

// All listings (top 500)
async function fetchMarket() {
  const c = getCache('market'); if (c) return c;
  try {
    const data = await cmcFetch('/cryptocurrency/listings/latest?start=1&limit=500&convert=USD');
    if (data?.status?.error_code && data.status.error_code !== 0) throw new Error(data.status.error_message);
    const coins = (data?.data || []).map(normalizeCMC);
    setCache('market', coins, 'market');
    console.log(`[CMC] ✓ ${coins.length} coins`);
    return coins;
  } catch (e) {
    console.error(`[CMC listings] ${e.message}`);
    // CoinGecko fallback
    const data = await fetchJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h,7d', {}, 2, 15000);
    const coins = (data || []).map(c => ({ id: c.id, name: c.name, symbol: c.symbol.toUpperCase(), rank: c.market_cap_rank, slug: c.id, image: c.image, current_price: c.current_price || 0, market_cap: c.market_cap || 0, total_volume: c.total_volume || 0, price_change_percentage_1h_in_currency: c.price_change_percentage_1h_in_currency || 0, price_change_percentage_24h: c.price_change_percentage_24h || 0, price_change_percentage_7d_in_currency: c.price_change_percentage_7d_in_currency || 0, circulating_supply: c.circulating_supply || 0, max_supply: c.max_supply || 0, total_supply: c.total_supply || 0, market_cap_rank: c.market_cap_rank }));
    setCache('market', coins, 'market');
    console.log(`[CoinGecko fallback] ${coins.length} coins`);
    return coins;
  }
}

// Gainers — top 20 by 24h gain
async function fetchGainers() {
  const c = getCache('gainers'); if (c) return c;
  const data = await cmcFetch('/cryptocurrency/listings/latest?start=1&limit=200&convert=USD&sort=percent_change_24h&sort_dir=desc');
  const r = (data?.data || []).filter(c => (c.quote?.USD?.percent_change_24h || 0) > 0).slice(0, 50).map(normalizeCMC);
  setCache('gainers', r, 'trending'); return r;
}

// Losers — bottom 20 by 24h change
async function fetchLosers() {
  const c = getCache('losers'); if (c) return c;
  const data = await cmcFetch('/cryptocurrency/listings/latest?start=1&limit=200&convert=USD&sort=percent_change_24h&sort_dir=asc');
  const r = (data?.data || []).filter(c => (c.quote?.USD?.percent_change_24h || 0) < 0).slice(0, 50).map(normalizeCMC);
  setCache('losers', r, 'trending'); return r;
}

// Trending — CMC trending endpoint
async function fetchTrending() {
  const c = getCache('trending'); if (c) return c;
  try {
    const data = await cmcFetch('/cryptocurrency/trending/latest?limit=20&convert=USD');
    const r = (data?.data || []).map(normalizeCMC);
    setCache('trending', r, 'trending'); return r;
  } catch (e) {
    // fallback: sort by volume
    const all = await fetchMarket();
    const r = [...all].sort((a, b) => b.total_volume - a.total_volume).slice(0, 20);
    setCache('trending', r, 'trending'); return r;
  }
}

// New listings
async function fetchNewListings() {
  const c = getCache('new_listings'); if (c) return c;
  try {
    const data = await cmcFetch('/cryptocurrency/listings/new?limit=20&convert=USD');
    const r = (data?.data || []).map(normalizeCMC);
    setCache('new_listings', r, 'trending'); return r;
  } catch (e) {
    const all = await fetchMarket();
    const r = [...all].sort((a, b) => b.id - a.id).slice(0, 20);
    setCache('new_listings', r, 'trending'); return r;
  }
}

// Coin detail info — fetch by CMC numeric ID, includes description + URLs
async function fetchCoinInfo(id) {
  const cacheKey = `info_${id}`;
  const c = getCache(cacheKey); if (c) return c;
  // aux=urls,logo,description,tags,platform,date_added,notice gives full info
  const data = await cmcFetch(`/cryptocurrency/info?id=${id}&aux=urls,logo,description,tags,date_added`);
  if (data?.status?.error_code && data.status.error_code !== 0) throw new Error(data.status.error_message);
  const r = data?.data || {};
  setCache(cacheKey, r, 'info');
  console.log(`[CMC Info] id=${id} keys=${Object.keys(r).join(',')}`);
  return r;
}

// Logos map
async function fetchLogos() {
  const c = getCache('logos'); if (c) return c;
  const coins = await fetchMarket();
  const logos = {}; coins.forEach(c => { if (c.symbol && c.image) logos[c.symbol.toUpperCase()] = c.image; });
  setCache('logos', logos, 'market'); return logos;
}

// ═══════════════════ NEWS ════════════════════════════════════════════════════
async function fetchNews() {
  const c = getCache('news'); if (c) return c;
  const items = [];
  for (const src of [{ url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' }, { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' }]) {
    try {
      const xml = await fetchText(src.url);
      const rx = /<item>([\s\S]*?)<\/item>/g; let m;
      while ((m = rx.exec(xml)) && items.length < 40) {
        const it = m[1], get = (tag) => { const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`); const x = r.exec(it); return x ? (x[1] || x[2] || '').trim() : ''; };
        const title = get('title'), link = get('link') || get('guid'), pub = get('pubDate');
        if (title) items.push({ title, link, published: pub, source: src.name });
      }
    } catch (e) { console.log(`[News] ${src.name}: ${e.message}`); }
  }
  items.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  setCache('news', items, 'news'); return items;
}

// ═══════════════════ AUTH ROUTES ══════════════════════════════════════════════
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ ok: false, error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password min 6 chars' });
  if (users.has(email.toLowerCase())) return res.status(409).json({ ok: false, error: 'Email already registered' });
  users.set(email.toLowerCase(), { email: email.toLowerCase(), name, passwordHash: hashPw(password) });
  res.json({ ok: true, token: signJWT({ email: email.toLowerCase(), name }), user: { email: email.toLowerCase(), name } });
});
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const u = users.get(email?.toLowerCase());
  if (!u || u.passwordHash !== hashPw(password)) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  res.json({ ok: true, token: signJWT({ email: u.email, name: u.name }), user: { email: u.email, name: u.name } });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

// ── Password Reset Routes ──────────────────────────────────────────────────────

// 1. Request reset — sends email with link
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });

  const user = users.get(email.toLowerCase());

  // Always return success (don't reveal if email exists = security best practice)
  if (!user) {
    console.log(`[Reset] Email not found: ${email} (silently ignored)`);
    return res.json({ ok: true, message: 'If this email is registered, a reset link has been sent.' });
  }

  // Generate secure token, expires in 1 hour
  const token = generateResetToken();
  const expires = Date.now() + 3_600_000; // 1 hour
  resetTokens.set(token, { email: user.email, expires });

  // Clean up old tokens for this email
  for (const [t, data] of resetTokens.entries()) {
    if (data.email === user.email && t !== token) resetTokens.delete(t);
    if (data.expires < Date.now()) resetTokens.delete(t); // remove expired
  }

  const resetUrl = `${FRONTEND_URL()}?reset=${token}`;

  try {
    await sendEmail({
      to: user.email,
      subject: '🔐 Reset your Funding Radar password',
      text: `Hi ${user.name},

Reset your password here: ${resetUrl}

This link expires in 1 hour.

If you didn't request this, ignore this email.`,
      html: resetEmailHTML(user.name, resetUrl),
    });
    console.log(`[Reset] Email sent to ${user.email}`);
    res.json({ ok: true, message: 'Reset link sent! Check your email.' });
  } catch (e) {
    console.error('[Reset] Email send failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to send email. Check RESEND_API_KEY in Railway Variables.' });
  }
});

// 2. Verify token — check if reset link is valid
app.get('/api/auth/verify-reset', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
  const data = resetTokens.get(token);
  if (!data) return res.status(400).json({ ok: false, error: 'Invalid or expired reset link' });
  if (data.expires < Date.now()) {
    resetTokens.delete(token);
    return res.status(400).json({ ok: false, error: 'Reset link has expired. Please request a new one.' });
  }
  res.json({ ok: true, email: data.email });
});

// 3. Reset password — set new password using token
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ ok: false, error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });

  const data = resetTokens.get(token);
  if (!data) return res.status(400).json({ ok: false, error: 'Invalid or expired reset link' });
  if (data.expires < Date.now()) {
    resetTokens.delete(token);
    return res.status(400).json({ ok: false, error: 'Reset link has expired' });
  }

  const user = users.get(data.email);
  if (!user) return res.status(400).json({ ok: false, error: 'User not found' });

  // Update password
  user.passwordHash = hashPw(password);
  users.set(data.email, user);
  resetTokens.delete(token); // one-time use

  console.log(`[Reset] Password changed for ${data.email}`);

  // Send confirmation email
  try {
    await sendEmail({
      to: user.email,
      subject: '✅ Your Funding Radar password has been changed',
      text: `Hi ${user.name},

Your password has been successfully changed.

If you did not make this change, contact support immediately.`,
      html: resetSuccessHTML(user.name),
    });
  } catch (e) {
    console.log('[Reset] Confirmation email failed (non-critical):', e.message);
  }

  // Auto-login with new token
  const loginToken = signJWT({ email: user.email, name: user.name });
  res.json({ ok: true, message: 'Password changed successfully!', token: loginToken, user: { email: user.email, name: user.name } });
});

// ═══════════════════ DATA ROUTES ══════════════════════════════════════════════
const FETCHERS = { binance: fetchBinance, bybit: fetchBybit, bitget: fetchBitget, gate: fetchGate, hyperliquid: fetchHyperliquid };
const EX_NAMES = Object.keys(FETCHERS);

app.get('/api/funding', auth, async (req, res) => {
  const t = Date.now();
  const results = await Promise.allSettled(EX_NAMES.map(k => FETCHERS[k]()));
  let data = []; const errors = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') data.push(...r.value); else { console.error(`[${EX_NAMES[i]}]`, r.reason?.message); errors.push({ exchange: EX_NAMES[i], error: r.reason?.message }); } });
  res.json({ ok: true, count: data.length, ts: Date.now(), errors: errors.length ? errors : undefined, data });
});

app.get('/api/market', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchMarket() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/market/gainers', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchGainers() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/market/losers', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchLosers() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/market/trending', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchTrending() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/market/new', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchNewListings() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/coin/:id', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchCoinInfo(req.params.id) }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/logos', async (req, res) => {
  try { res.json({ ok: true, logos: await fetchLogos() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/news', auth, async (req, res) => {
  try { res.json({ ok: true, data: await fetchNews() }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.get('/api/status', (req, res) => {
  const s = {}; EX_NAMES.forEach(k => { const e = cache[k]; s[k] = e ? { ok: true, age: Math.round((Date.now() - e.ts) / 1000) + 's', count: e.data.length } : { ok: false }; });
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()) + 's',
    region: process.env.RAILWAY_REGION || 'local',
    cmc: CMC_KEY() ? 'SET ✓' : 'NOT SET',
    resend: process.env.RESEND_API_KEY ? 'SET ✓' : 'NOT SET ⚠️',
    from_email: process.env.FROM_EMAIL || 'not set',
    frontend_url: process.env.FRONTEND_URL || 'not set',
    cache: s
  });
});
app.get('*', (req, res) => res.sendFile(join(__dirname, '../public/index.html')));

createServer(app).listen(PORT, () => {
  console.log(`\n🚀 Funding Radar v11 → http://localhost:${PORT}`);
  console.log(`   CMC: ${CMC_KEY() ? 'KEY SET ✓' : 'NO KEY'}`);
  console.log(`   Exchanges: ${EX_NAMES.join(' · ')}\n`);
  setTimeout(async () => {
    await fetchMarket().then(d => console.log(`[Boot] ${d.length} coins cached`)).catch(e => console.log('[Boot]', e.message));
    await fetchNews().catch(() => {});
  }, 4000);
});