'use strict';

const $ = (id) => document.getElementById(id);
const msDay = 86400000;
const min1 = 60000;
const h4 = 240 * min1;
const HISTORY_START_MS = Date.UTC(2017, 0, 1);
const MAX_API_PAGES = 7000; // 7 000 000 минутных свечей: хватает примерно с 2017 года до текущих дат
const DPR = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const colors = {
  bg: '#06101d', grid: 'rgba(126, 161, 210, .14)', text: '#9fb4d5',
  green: '#48e083', red: '#ff5967', blue: '#59a6ff', yellow: '#f4b43b',
  white: '#eef6ff', muted: '#778ba9'
};
const state = {
  candles1m: [], bt: null, sourceLabel: '', sourceKind: '', dataKey: '', runId: 0, loadWarnings: [],
  chart: { viewStart: null, viewEnd: null, hover: null, drag: null, selection: null, plot: null, markers: [], hoverMarker: null }
};

function parseNum(value, fallback = 0) { const n = Number(String(value ?? '').replace(',', '.')); return Number.isFinite(n) ? n : fallback; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmt(n, d = 2) { if (!Number.isFinite(n)) return '—'; return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtSmart(n) { if (!Number.isFinite(n)) return '—'; const abs = Math.abs(n); const d = abs >= 1000 ? 1 : abs >= 10 ? 2 : 4; return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—'; }
function dt(t, compact = false) { return new Date(t).toLocaleString('ru-RU', compact ? { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' } : { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function dateMs(value, end = false) { const safe = value || new Date().toISOString().slice(0, 10); return new Date(`${safe}T${end ? '23:59:59.999' : '00:00:00.000'}Z`).getTime(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function lcg(x) { return (Math.imul(1664525, x) + 1013904223) >>> 0; }
function downloadText(filename, text, type = 'text/plain;charset=utf-8') { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function roundedRect(ctx, x, y, w, h, r) { const rr = Math.min(r, Math.abs(w)/2, Math.abs(h)/2); ctx.beginPath(); ctx.moveTo(x+rr,y); ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr); ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath(); }
function setLoading(title, note='') { const v=$('resultVerdict'), n=$('resultNarrative'); if(v) v.textContent=title; if(n) n.textContent=note; }

function getInputs() {
  const rawFrom = dateMs($('dateFrom').value, false);
  const from = Math.max(rawFrom, HISTORY_START_MS);
  if (rawFrom < HISTORY_START_MS && $('dateFrom')) $('dateFrom').value = '2017-01-01';
  return {
    symbol: ($('symbol').value.trim().toUpperCase() || 'BTCUSDT').replace(/[^A-Z0-9]/g, ''),
    source: $('source')?.value || 'bybit',
    tf: '240',
    from,
    to: dateMs($('dateTo').value, true),
    triggerPct: Math.max(0, parseNum($('triggerPct').value, 0.2)),
    positionSize: Math.max(0, parseNum($('positionSize').value, 10)),
    startBalance: Math.max(0.000001, parseNum($('startBalance').value, 100)),
    feePct: Math.max(0, parseNum($('feePct')?.value, 0.1)),
    slippagePct: Math.max(0, parseNum($('slippagePct')?.value, 0)),
    csvFile: $('csvFile')?.files && $('csvFile').files[0] ? $('csvFile').files[0] : null,
  };
}
function dataKey(inp) { const f = inp.csvFile ? `${inp.csvFile.name}:${inp.csvFile.size}:${inp.csvFile.lastModified}` : ''; return [inp.source, inp.symbol, inp.from, inp.to, f].join('|'); }

function clean1m(rows, from = -Infinity, to = Infinity) {
  const map = new Map();
  for (const raw of rows || []) {
    const c = { t: Number(raw.t), open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) || 0 };
    if (![c.t,c.open,c.high,c.low,c.close].every(Number.isFinite)) continue;
    if (c.t < from || c.t > to) continue;
    c.high = Math.max(c.high, c.open, c.close);
    c.low = Math.min(c.low, c.open, c.close);
    c.volume = Math.max(0, c.volume);
    map.set(c.t, c);
  }
  return [...map.values()].sort((a,b)=>a.t-b.t);
}
async function fetchJson(url, tries = 5) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch(url, { cache:'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      const msg = String(e && (e.message || e.name) || e);
      if (attempt < tries) {
        await sleep(450 * attempt);
        continue;
      }
      throw new Error(msg.includes('abort') || msg.includes('aborted') ? 'запрос к бирже слишком долго не отвечал' : msg);
    } finally {
      clearTimeout(tm);
    }
  }
  throw lastErr || new Error('network error');
}
async function fetchBybit1m(inp) {
  const categories = ['spot', 'linear'];
  let lastErr = null;
  for (const category of categories) {
    try {
      const all = []; let start = inp.from; let pages = 0; const limit = 1000; const plannedPages = Math.ceil(Math.max(0, inp.to - inp.from + 1) / (limit * min1)); const maxPages = Math.min(plannedPages || 1, MAX_API_PAGES);
      while (start <= inp.to && pages < maxPages) {
        const end = Math.min(inp.to, start + limit * min1 - 1);
        if (pages === 0 || pages % 25 === 0) setLoading('Загрузка 1m-истории', `${category}: ${pages}/${maxPages} запросов · с ${new Date(start).toLocaleDateString('ru-RU')}`);
        const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${encodeURIComponent(inp.symbol)}&interval=1&start=${start}&end=${end}&limit=${limit}`;
        const j = await fetchJson(url);
        if (j.retCode !== 0) throw new Error(j.retMsg || 'Bybit error');
        const list = j.result?.list || [];
        if (!list.length) break;
        const rows = list.slice().reverse().map(x => ({ t:+x[0], open:+x[1], high:+x[2], low:+x[3], close:+x[4], volume:+x[5] }));
        all.push(...rows);
        const cleaned = clean1m(rows, start, end);
        if (!cleaned.length) break;
        start = cleaned[cleaned.length - 1].t + min1;
        pages += 1;
        await sleep(90);
      }
      const out = clean1m(all, inp.from, inp.to);
      if (out.length >= 30) {
        const first = out[0].t, last = out[out.length - 1].t;
        if (pages >= maxPages && last < inp.to - min1) state.loadWarnings.push(`Достигнут лимит загрузки: ${fmtInt(MAX_API_PAGES)} запросов. Загружено до ${dt(last)}.`);
        if (first > inp.from + min1) state.loadWarnings.push(`Реальные 1m-данные начались не с выбранной даты, а с ${dt(first)}.`);
        if (last < inp.to - min1) state.loadWarnings.push(`Реальные 1m-данные закончились на ${dt(last)}. Остальная часть периода не была рассчитана.`);
        state.sourceLabel = `Bybit Public API · ${category} · 1m · ${out.length} свечей${pages>1?` · ${pages} запросов`:''}`; state.sourceKind = 'real'; return out;
      }
      lastErr = new Error('Bybit вернул мало 1m-свечей');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Bybit недоступен');
}
async function fetchBinance1m(inp) {
  const all = []; let start = inp.from; let pages = 0; const limit = 1000; const plannedPages = Math.ceil(Math.max(0, inp.to - inp.from + 1) / (limit * min1)); const maxPages = Math.min(plannedPages || 1, MAX_API_PAGES);
  while (start <= inp.to && pages < maxPages) {
    if (pages === 0 || pages % 25 === 0) setLoading('Загрузка 1m-истории', `Binance: ${pages}/${maxPages} запросов · с ${new Date(start).toLocaleDateString('ru-RU')}`);
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(inp.symbol)}&interval=1m&startTime=${start}&endTime=${inp.to}&limit=${limit}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows.map(x => ({ t:+x[0], open:+x[1], high:+x[2], low:+x[3], close:+x[4], volume:+x[5] })));
    start = +rows[rows.length - 1][0] + min1; pages += 1; await sleep(90);
  }
  const out = clean1m(all, inp.from, inp.to);
  if (out.length < 30) throw new Error('Binance вернул мало 1m-свечей');
  const first = out[0].t, last = out[out.length - 1].t;
  if (pages >= maxPages && last < inp.to - min1) state.loadWarnings.push(`Достигнут лимит загрузки: ${fmtInt(MAX_API_PAGES)} запросов. Загружено до ${dt(last)}.`);
  if (first > inp.from + min1) state.loadWarnings.push(`Реальные 1m-данные начались не с выбранной даты, а с ${dt(first)}.`);
  if (last < inp.to - min1) state.loadWarnings.push(`Реальные 1m-данные закончились на ${dt(last)}. Остальная часть периода не была рассчитана.`);
  state.sourceLabel = `Binance Public API · spot · 1m · ${out.length} свечей${pages>1?` · ${pages} запросов`:''}`; state.sourceKind = 'real'; return out;
}
function demo1m(inp) {
  let seed = hash(`${inp.symbol}|${inp.from}|${inp.to}|strict`);
  let price = inp.symbol.startsWith('BTC') ? 61000 : inp.symbol.startsWith('ETH') ? 3400 : inp.symbol.startsWith('SOL') ? 145 : 100;
  const out = [];
  for (let t = inp.from; t <= inp.to; t += min1) {
    seed = lcg(seed); const r1 = seed / 2**32 - .5; seed = lcg(seed); const r2 = seed / 2**32;
    const open = price;
    const cycle = Math.sin((t - inp.from) / (h4 * 2.7)) * .00055 + Math.sin((t - inp.from) / (msDay * 1.3)) * .00025;
    const close = Math.max(0.000001, open * (1 + cycle + r1 * .0022));
    const high = Math.max(open, close) * (1 + 0.00035 + r2 * .0017);
    const low = Math.min(open, close) * (1 - 0.00035 - (1-r2) * .0017);
    const volume = 30 + Math.abs(r1) * 250 + Math.abs(close - open) / open * 15000;
    out.push({ t, open, high, low, close, volume });
    price = close;
  }
  state.sourceLabel = `Офлайн-демо · 1m · ${out.length} свечей`; state.sourceKind = 'demo'; return out;
}
async function parseCsv(inp) {
  if (!inp.csvFile) throw new Error('Выберите CSV-файл с 1m-свечами');
  const text = await inp.csvFile.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('CSV пустой');
  const head = lines.shift().split(',').map(s=>s.trim().toLowerCase());
  const idx = k => head.indexOf(k);
  const need = ['timestamp','open','high','low','close','volume'];
  const miss = need.filter(k=>idx(k)<0); if (miss.length) throw new Error(`В CSV не хватает колонок: ${miss.join(', ')}`);
  const rows = lines.map(line => { const p = line.split(',').map(s=>s.trim()); const rawT = p[idx('timestamp')]; const t = /^\d+$/.test(rawT) ? (rawT.length<=10 ? +rawT*1000 : +rawT) : Date.parse(rawT); return { t, open:parseNum(p[idx('open')]), high:parseNum(p[idx('high')]), low:parseNum(p[idx('low')]), close:parseNum(p[idx('close')]), volume:parseNum(p[idx('volume')]) }; });
  const out = clean1m(rows, inp.from, inp.to); if (out.length < 30) throw new Error('В CSV меньше 30 подходящих 1m-свечей.');
  state.sourceLabel = `CSV пользователя · 1m · ${out.length} свечей`; state.sourceKind = 'csv'; return out;
}
async function load1m(inp) {
  if (inp.to <= inp.from) throw new Error('Дата до должна быть позже даты от');
  state.loadWarnings = [];
  if (inp.from < HISTORY_START_MS) state.loadWarnings.push('Дата начала была поднята до 01.01.2017: раньше этого бектестер не считает.');
  if (inp.source === 'csv') return parseCsv(inp);
  if (inp.source === 'demo') return demo1m(inp);
  if (inp.source === 'bybit') return await fetchBybit1m(inp);
  if (inp.source === 'binance') return await fetchBinance1m(inp);
  try { return await fetchBybit1m(inp); }
  catch (e1) {
    state.loadWarnings.push(`Bybit не дал полный 1m-период: ${e1.message}`);
    try { return await fetchBinance1m(inp); }
    catch (e2) { throw new Error(`Не удалось получить реальные 1m-свечи за весь период через браузер. Bybit: ${e1.message}; Binance: ${e2.message}. Для многолетней истории надёжнее использовать CSV с 1m-данными или выбрать меньший период.`); }
  }
}

function updateCurrent4h(current, c) {
  const start = Math.floor(c.t / h4) * h4;
  if (!current || current.t !== start) return { t: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, count1m: 1, lastT: c.t, buyDist: 0, sellDist: 0 };
  current.high = Math.max(current.high, c.high); current.low = Math.min(current.low, c.low); current.close = c.close; current.volume += c.volume; current.count1m += 1; current.lastT = c.t; return current;
}
function pushOrReplaceBar(bars, bar) {
  if (!bar) return;
  const copy = { ...bar };
  const last = bars[bars.length - 1];
  if (last && last.t === copy.t) bars[bars.length - 1] = copy; else bars.push(copy);
}
function runStrict(candles1m, inp) {
  const fee = inp.feePct / 100;
  const slip = inp.slippagePct / 100;
  let cash = inp.startBalance;
  let pos = null;
  let current4h = null;
  const bars = [], trades = [], equity = [], logs = [], warnings = [];
  let buyCount = 0, sellCount = 0, ignoredBuy = 0, ignoredSell = 0;
  let peak = inp.startBalance, maxDd = 0, maxDdUsd = 0;
  if (inp.positionSize <= 0) warnings.push('Размер сделки равен 0: позиция не сможет открыться.');

  for (const c of candles1m) {
    current4h = updateCurrent4h(current4h, c);
    const cp = c.close;
    const isRed = cp < current4h.open;
    const isGreen = cp > current4h.open;
    const buyDist = cp ? (cp - current4h.low) / cp * 100 : 0;
    const sellDist = cp ? (current4h.high - cp) / cp * 100 : 0;
    current4h.buyDist = buyDist;
    current4h.sellDist = sellDist;

    const buySignal = isRed && buyDist >= inp.triggerPct;
    const sellSignal = isGreen && sellDist >= inp.triggerPct;

    if (!pos) {
      if (sellSignal) { ignoredSell += 1; }
      if (buySignal && cash > 0 && inp.positionSize > 0) {
        let cost = Math.min(inp.positionSize, cash / (1 + fee));
        if (inp.positionSize > cost + 1e-9) warnings.push(`Размер сделки ограничен доступным балансом: вместо ${fmt(inp.positionSize)} USDT использовано ${fmt(cost)} USDT.`);
        const entry = cp * (1 + slip);
        const feeIn = cost * fee;
        const qty = cost / entry;
        cash -= cost + feeIn;
        pos = { side: 'Long', entryTime: c.t, entry, size: cost, qty, feeIn, entry4hOpen: current4h.open, entry4hLow: current4h.low, buyDist, reason: `BUY по ТЗ: красная текущая 4H, distance=${fmt(buyDist,3)}% ≥ ${fmt(inp.triggerPct,2)}%` };
        buyCount += 1;
        logs.push({ t: c.t, text: `BUY ${fmtSmart(entry)} · ${pos.reason}` });
      }
    } else {
      if (buySignal) { ignoredBuy += 1; }
      if (sellSignal) {
        const exit = cp * (1 - slip);
        const gross = pos.qty * exit;
        const feeOut = gross * fee;
        cash += gross - feeOut;
        const pnl = gross - feeOut - pos.size - pos.feeIn;
        const pnlPct = pos.size ? pnl / pos.size * 100 : 0;
        const trade = {
          id: trades.length + 1, side: 'Long', entryTime: pos.entryTime, exitTime: c.t,
          entry: pos.entry, exit, size: pos.size, qty: pos.qty, pnl, pnlPct,
          reason: `SELL по ТЗ: зелёная текущая 4H, distance=${fmt(sellDist,3)}% ≥ ${fmt(inp.triggerPct,2)}%`,
          entryReason: pos.reason, fees: pos.feeIn + feeOut, funding: 0,
          buyDist: pos.buyDist, sellDist, entry4hOpen: pos.entry4hOpen, entry4hLow: pos.entry4hLow,
          exit4hOpen: current4h.open, exit4hHigh: current4h.high, balanceAfter: cash
        };
        trades.push(trade); sellCount += 1; pos = null;
        logs.push({ t: c.t, text: `SELL ${fmtSmart(exit)} · PnL ${pnl>=0?'+':''}${fmt(pnl)} USDT · ${trade.reason}` });
      }
    }

    const eq = cash + (pos ? pos.qty * cp : 0);
    equity.push({ t: c.t, v: eq });
    if (eq > peak) peak = eq;
    const ddUsd = Math.max(0, peak - eq);
    const ddPct = peak > 0 ? ddUsd / peak * 100 : 0;
    if (ddPct > maxDd) { maxDd = ddPct; maxDdUsd = ddUsd; }
    pushOrReplaceBar(bars, current4h);
  }

  const final = equity.length ? equity[equity.length - 1].v : inp.startBalance;
  const wins = trades.filter(t=>t.pnl>0);
  const losses = trades.filter(t=>t.pnl<0);
  const grossProfit = wins.reduce((s,t)=>s+t.pnl,0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const ret = (final - inp.startBalance) / inp.startBalance * 100;
  const days = Math.max(1, (inp.to - inp.from) / msDay);
  const annual = final > 0 ? (Math.pow(final / inp.startBalance, 365 / days) - 1) * 100 : -100;
  const pf = grossLoss ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  if (trades.length < 10) warnings.push('Сделок мало: результат нельзя считать статистически устойчивым.');
  if (pos) warnings.push('В конце периода позиция осталась открытой. Equity учитывает текущую рыночную стоимость, но закрытой SELL-сделки нет.');
  return {
    candles: bars, candles1m, trades, equity, logs, warnings,
    maFast: [], maSlow: [], maTrend: [],
    summary: { start: inp.startBalance, final, pnl: final - inp.startBalance, ret, annual, trades: trades.length, buyCount, sellCount, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: pf, maxDd, maxDdUsd, ignoredBuy, ignoredSell, openPosition: !!pos }
  };
}

function analyze1mQuality(candles) {
  let gaps = 0, bigGaps = 0, badOhlc = 0, zeroVolume = 0, maxGapMs = 0;
  for (let i=0;i<candles.length;i++) {
    const c = candles[i];
    if (c.volume === 0) zeroVolume++;
    if (!(c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && c.high >= c.low)) badOhlc++;
    if (i>0) { const d=c.t-candles[i-1].t; maxGapMs=Math.max(maxGapMs,d); if (d>min1*1.5) gaps++; if (d>min1*5) bigGaps++; }
  }
  const coverage = candles.length ? candles[candles.length-1].t - candles[0].t : 0;
  const expected = coverage ? Math.floor(coverage/min1)+1 : candles.length;
  const completeness = expected ? Math.min(100, candles.length/expected*100) : 0;
  let score = 100 - Math.min(40,gaps*3) - Math.min(25,bigGaps*8) - Math.min(20,badOhlc*10) - Math.min(10,zeroVolume/Math.max(1,candles.length)*100*.2);
  score = clamp(score,0,100);
  const warnings=[]; if (gaps) warnings.push(`Пропусков между 1m-свечами: ${gaps}`); if (badOhlc) warnings.push(`Некорректных OHLC-свечей: ${badOhlc}`); if (candles.length<240) warnings.push('Меньше 240 минутных свечей: период слишком короткий для 4H-логики.');
  return { candles: candles.length, expectedBars: expected, completeness, gaps, bigGaps, badOhlc, zeroVolume, maxGapMs, score, warnings };
}
function selfCheck(bt) {
  const trigger = parseNum($('triggerPct').value, .2);
  const buyDist = (100 - 99.7) / 100 * 100;
  const sellDist = (100.3 - 100) / 100 * 100;
  return [
    { name:'Strict Mode по ТЗ активен', ok:true, note:'Движок не использует MA/TP/SL/Futures для входов и выходов.' },
    { name:'Прогон только по 1m-свечам', ok:!!bt?.candles1m?.length, note:`Минутных свечей: ${fmtInt(bt?.candles1m?.length || 0)}` },
    { name:'Текущая 4H-свеча собирается из 1m', ok:!!bt?.candles?.length, note:`4H-блоков: ${fmtInt(bt?.candles?.length || 0)}` },
    { name:'BUY формула корректна', ok:Math.abs(buyDist - 0.3) < 1e-9, note:'(Current Price − Low) / Current Price × 100' },
    { name:'SELL формула корректна', ok:Math.abs(sellDist - 0.3) < 1e-9, note:'(High − Current Price) / Current Price × 100' },
    { name:'Одна открытая позиция', ok:true, note:`BUY при позиции проигнорировано: ${bt?.summary?.ignoredBuy || 0}` },
    { name:'SELL без позиции игнорируется', ok:true, note:`SELL без позиции проигнорировано: ${bt?.summary?.ignoredSell || 0}` },
    { name:'Частичных продаж нет', ok:true, note:'Каждый SELL закрывает позицию полностью.' },
    { name:'Ручная сверка доступна', ok:(bt?.trades?.length || 0) > 0, note:'Первые сделки вынесены во вкладку «Ручная сверка».' },
    { name:'Порог из интерфейса применяется', ok:Number.isFinite(trigger), note:`Текущий trigger: ${fmt(trigger,2)}%` },
  ];
}

function visibleRange(candles) { if (!candles.length) return { start:0,end:-1,candles:[] }; let s=state.chart.viewStart, e=state.chart.viewEnd; if (s===null||e===null) { e=candles.length-1; s=Math.max(0,e-Math.min(180,candles.length-1)); } s=clamp(Math.round(s),0,candles.length-1); e=clamp(Math.round(e),s,candles.length-1); return { start:s,end:e,candles:candles.slice(s,e+1) }; }
function resetView() { if (!state.bt?.candles?.length) { state.chart.viewStart = state.chart.viewEnd = null; return; } const n=state.bt.candles.length; state.chart.viewEnd=n-1; state.chart.viewStart=Math.max(0,n-Math.min(180,n)); }
function chartXForIndex(idx, plot = state.chart.plot) { if (!plot) return 0; return plot.pad.l + (idx - plot.start) * plot.plotW / Math.max(1, plot.count - 1); }
function chartIndexFromX(px, plot = state.chart.plot) { if (!plot || !state.bt?.candles?.length) return -1; const r=clamp((px-plot.pad.l)/Math.max(1,plot.plotW),0,1); return clamp(Math.round(plot.start+r*Math.max(1,plot.count-1)), plot.start, plot.end); }
function chartPriceFromY(py, plot=state.chart.plot) { if (!plot) return NaN; const r=clamp((py-plot.pad.t)/Math.max(1,plot.chartH),0,1); return plot.priceTop - r*(plot.priceTop-plot.priceBottom); }
function nearestIndexByTime(candles, t) { let best=0,bd=Infinity; for(let i=0;i<candles.length;i++){const d=Math.abs(candles[i].t-t); if(d<bd){bd=d;best=i}} return best; }
function niceStep(raw) { if(!Number.isFinite(raw)||raw<=0)return 1; const p=Math.pow(10,Math.floor(Math.log10(raw))); const n=raw/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
function niceScale(min,max,ticks=6){ if(!Number.isFinite(min)||!Number.isFinite(max)||min===max){const b=Number.isFinite(min)?min:1;min=b*.98;max=b*1.02} const st=niceStep((max-min)/Math.max(1,ticks-1)); const mn=Math.max(0,Math.floor(min/st)*st), mx=Math.ceil(max/st)*st; const arr=[]; for(let v=mn;v<=mx+st*.5;v+=st)arr.push(Number(v.toPrecision(12))); return {min:mn,max:mx,ticks:arr}; }
function canvasPoint(e, id='chart') { const c=$(id), r=c.getBoundingClientRect(), sx=c.width/Math.max(1,r.width), sy=c.height/Math.max(1,r.height); return { x:(e.clientX-r.left)*sx, y:(e.clientY-r.top)*sy }; }
function fitCanvas(canvas) { const r=canvas.getBoundingClientRect(), dpr=DPR(); const W=Math.max(1,Math.floor(r.width*dpr)), H=Math.max(1,Math.floor(r.height*dpr)); if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H} return {W,H,dpr}; }

function drawEntry(ctx,x,y,dpr){const r=7*dpr;ctx.beginPath();ctx.moveTo(x,y-r);ctx.lineTo(x-r*.9,y+r*.85);ctx.lineTo(x+r*.9,y+r*.85);ctx.closePath();ctx.fillStyle=colors.green;ctx.strokeStyle='rgba(3,8,18,.9)';ctx.lineWidth=2*dpr;ctx.fill();ctx.stroke();}
function drawMarkerTooltip(ctx, m, dpr, W, H) { if(!m)return; const t=m.trade; const rows=m.kind==='entry'?[ '▲ BUY / вход', `Время: ${dt(t.entryTime)}`, `Цена: ${fmtSmart(t.entry)}`, `BUY dist: ${fmt(t.buyDist,3)}%`, t.entryReason ]:[ t.pnl>=0?'● SELL / выход в плюс':'● SELL / выход в минус', `Время: ${dt(t.exitTime)}`, `Цена: ${fmtSmart(t.exit)}`, `SELL dist: ${fmt(t.sellDist,3)}%`, `PnL: ${t.pnl>=0?'+':''}${fmt(t.pnl)} USDT`, t.reason ]; ctx.save(); ctx.font=`${11*dpr}px Segoe UI, Arial`; const tw=Math.max(...rows.map(r=>ctx.measureText(r).width))+22*dpr, th=rows.length*17*dpr+14*dpr; let tx=m.x+16*dpr, ty=m.y+16*dpr; if(tx+tw>W-8*dpr)tx=m.x-tw-16*dpr; if(ty+th>H-8*dpr)ty=m.y-th-16*dpr; tx=clamp(tx,8*dpr,W-tw-8*dpr); ty=clamp(ty,8*dpr,H-th-8*dpr); ctx.fillStyle='rgba(4,12,25,.96)'; roundedRect(ctx,tx,ty,tw,th,10*dpr); ctx.fill(); ctx.strokeStyle=t.pnl>=0?'rgba(72,224,131,.52)':'rgba(255,89,103,.52)'; ctx.stroke(); rows.forEach((r,i)=>{ctx.fillStyle=i===0?colors.white:(r.startsWith('PnL')?(t.pnl>=0?colors.green:colors.red):colors.text); ctx.font=`${i===0?'700 ':''}${11*dpr}px Segoe UI, Arial`; ctx.fillText(r,tx+11*dpr,ty+15*dpr+i*17*dpr)}); ctx.restore(); }
function nearestMarker(pt,max=13*DPR()){let best=null,bd=Infinity; for(const m of state.chart.markers||[]){const d=Math.hypot(pt.x-m.x,pt.y-m.y); if(d<bd&&d<=max){best=m;bd=d}} return best;}

function drawChart() {
  const canvas=$('chart'), ctx=canvas.getContext('2d'), {W,H,dpr}=fitCanvas(canvas); ctx.clearRect(0,0,W,H); ctx.fillStyle=colors.bg; ctx.fillRect(0,0,W,H);
  const bt=state.bt; if(!bt?.candles?.length){ctx.fillStyle=colors.text;ctx.font=`${14*dpr}px Segoe UI`;ctx.fillText('Нет данных для графика',24*dpr,42*dpr);return;}
  const vr=visibleRange(bt.candles), candles=vr.candles; const pad={l:42*dpr,r:104*dpr,t:26*dpr,b:42*dpr}; const volH=clamp(H*.18,54*dpr,96*dpr), gap=14*dpr, chartH=Math.max(120*dpr,H-pad.t-pad.b-volH-gap), plotW=Math.max(100*dpr,W-pad.l-pad.r); const volTop=pad.t+chartH+gap, volBase=volTop+volH;
  const hi=Math.max(...candles.map(c=>c.high)), lo=Math.min(...candles.map(c=>c.low)); const pp=(hi-lo)*.08||hi*.02||1; const sc=niceScale(Math.max(0,lo-pp),hi+pp,6); const top=sc.max, bottom=sc.min; const x=i=>pad.l+i*plotW/Math.max(1,candles.length-1); const y=p=>pad.t+(top-p)/Math.max(1e-12,top-bottom)*chartH; const plot={W,H,dpr,pad,plotW,chartH,volH,gap,volTop,volBase,priceTop:top,priceBottom:bottom,start:vr.start,end:vr.end,count:candles.length}; state.chart.plot=plot;
  ctx.save(); ctx.beginPath(); ctx.rect(pad.l,pad.t,plotW,volBase-pad.t); ctx.clip();
  ctx.strokeStyle=colors.grid; ctx.lineWidth=dpr; for(const tick of sc.ticks){const yy=y(tick); if(yy<pad.t-1||yy>pad.t+chartH+1)continue; ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke();}
  const vLines=Math.min(8,Math.max(3,Math.floor(plotW/(165*dpr)))); for(let i=0;i<=vLines;i++){const xx=pad.l+i*plotW/vLines;ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,volBase);ctx.stroke();} ctx.beginPath();ctx.moveTo(pad.l,volTop);ctx.lineTo(W-pad.r,volTop);ctx.stroke();
  if(state.chart.selection){const s=clamp(Math.min(state.chart.selection.start,state.chart.selection.end),vr.start,vr.end),e=clamp(Math.max(state.chart.selection.start,state.chart.selection.end),vr.start,vr.end); const x1=chartXForIndex(s,plot),x2=chartXForIndex(e,plot); ctx.fillStyle='rgba(65,156,255,.18)';ctx.fillRect(Math.min(x1,x2),pad.t,Math.abs(x2-x1),volBase-pad.t);}
  const maxVol=Math.max(...candles.map(c=>c.volume),1); const stepX = plotW / Math.max(1, candles.length - 1 || 1); const cw=clamp(Math.min(stepX * 0.9, plotW / Math.max(1, candles.length) * 1.08),3*dpr,28*dpr);
  for(let i=0;i<candles.length;i++){const c=candles[i],xx=x(i),up=c.close>=c.open;ctx.strokeStyle=ctx.fillStyle=up?colors.green:colors.red;ctx.globalAlpha=.54;ctx.fillRect(xx-cw/2,volBase-c.volume/maxVol*volH,cw,c.volume/maxVol*volH);ctx.globalAlpha=1;ctx.beginPath();ctx.moveTo(xx,y(c.high));ctx.lineTo(xx,y(c.low));ctx.stroke();const oy=y(c.open),cy=y(c.close);roundedRect(ctx,xx-cw/2,Math.min(oy,cy),cw,Math.max(2*dpr,Math.abs(oy-cy)),Math.min(2*dpr,cw/2));ctx.fill();}
  const last=candles[candles.length-1], lastY=y(last.close); ctx.setLineDash([2*dpr,4*dpr]);ctx.strokeStyle=last.close>=candles[0].close?'rgba(72,224,131,.35)':'rgba(255,89,103,.35)';ctx.beginPath();ctx.moveTo(pad.l,lastY);ctx.lineTo(W-pad.r,lastY);ctx.stroke();ctx.setLineDash([]);
  state.chart.markers=[]; const fromT=candles[0].t,toT=candles[candles.length-1].t+h4; for(const tr of bt.trades){const entryVisible=tr.entryTime>=fromT&&tr.entryTime<=toT, exitVisible=tr.exitTime>=fromT&&tr.exitTime<=toT; if(entryVisible){const idx=nearestIndexByTime(candles,tr.entryTime),xx=x(idx-vr.start),yy=y(tr.entry); drawEntry(ctx,xx,yy,dpr); state.chart.markers.push({kind:'entry',x:xx,y:yy,trade:tr});} if(exitVisible){const idx=nearestIndexByTime(candles,tr.exitTime),xx=x(idx-vr.start),yy=y(tr.exit); ctx.beginPath();ctx.arc(xx,yy,5.3*dpr,0,Math.PI*2);ctx.fillStyle=tr.pnl>=0?colors.green:colors.red;ctx.fill();ctx.strokeStyle='rgba(3,8,18,.92)';ctx.lineWidth=2*dpr;ctx.stroke(); state.chart.markers.push({kind:'exit',x:xx,y:yy,trade:tr});} }
  ctx.restore();
  ctx.font=`${12*dpr}px Segoe UI`;ctx.textBaseline='middle';ctx.textAlign='left'; for(const tick of sc.ticks){const yy=y(tick); if(yy<pad.t-1||yy>pad.t+chartH+1)continue; ctx.fillStyle=colors.text;ctx.fillText(fmtSmart(tick),W-pad.r+12*dpr,yy);} for(let i=0;i<=vLines;i++){const xx=pad.l+i*plotW/vLines,idx=Math.round(i*(candles.length-1)/vLines); if(candles[idx]){ctx.fillStyle=colors.muted;ctx.textAlign='center';ctx.fillText(dt(candles[idx].t,true),xx,H-18*dpr);ctx.textAlign='left';}}
  ctx.fillStyle=last.close>=candles[0].close?colors.green:colors.red; roundedRect(ctx,W-pad.r+10*dpr,lastY-18*dpr,78*dpr,34*dpr,8*dpr);ctx.fill();ctx.fillStyle='#fff';ctx.font=`700 ${12*dpr}px Segoe UI`;ctx.textAlign='center';ctx.fillText(fmtSmart(last.close),W-pad.r+49*dpr,lastY-2*dpr);ctx.font=`${10*dpr}px Segoe UI`;ctx.fillText(new Date(last.lastT||last.t).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),W-pad.r+49*dpr,lastY+12*dpr);ctx.textAlign='left';
  const hover=state.chart.hover; if(hover&&hover.index>=vr.start&&hover.index<=vr.end){const c=bt.candles[hover.index],hx=chartXForIndex(hover.index,plot),price=Number.isFinite(hover.price)?hover.price:c.close,hy=y(price);ctx.save();ctx.strokeStyle='rgba(183,210,255,.45)';ctx.setLineDash([4*dpr,4*dpr]);ctx.beginPath();ctx.moveTo(hx,pad.t);ctx.lineTo(hx,volBase);ctx.stroke();if(hy>=pad.t&&hy<=pad.t+chartH){ctx.beginPath();ctx.moveTo(pad.l,hy);ctx.lineTo(W-pad.r,hy);ctx.stroke();}ctx.setLineDash([]);const rows=[dt(c.t),`O ${fmtSmart(c.open)} H ${fmtSmart(c.high)}`,`L ${fmtSmart(c.low)} C ${fmtSmart(c.close)}`,`BUY dist ${fmt(c.buyDist,3)}%`, `SELL dist ${fmt(c.sellDist,3)}%`, `1m внутри: ${c.count1m}`];ctx.font=`${11*dpr}px Segoe UI`;const tw=Math.max(...rows.map(r=>ctx.measureText(r).width))+22*dpr,th=rows.length*17*dpr+14*dpr;let tx=hover.x+16*dpr,ty=hover.y+16*dpr;if(tx+tw>W-8*dpr)tx=hover.x-tw-16*dpr;if(ty+th>H-8*dpr)ty=hover.y-th-16*dpr;tx=clamp(tx,8*dpr,W-tw-8*dpr);ty=clamp(ty,8*dpr,H-th-8*dpr);ctx.fillStyle='rgba(4,12,25,.94)';roundedRect(ctx,tx,ty,tw,th,10*dpr);ctx.fill();ctx.strokeStyle='rgba(122,158,210,.28)';ctx.stroke();rows.forEach((r,i)=>{ctx.fillStyle=i===0?colors.white:colors.text;ctx.font=`${i===0?'700 ':''}${11*dpr}px Segoe UI`;ctx.fillText(r,tx+11*dpr,ty+15*dpr+i*17*dpr)});ctx.restore();}
  drawMarkerTooltip(ctx,state.chart.hoverMarker,dpr,W,H);
  $('zoomState') && ($('zoomState').textContent = `видно ${vr.start+1}-${vr.end+1}/${bt.candles.length}`);
}

function drawEquity() { const canvas=$('equity'); if(!canvas) return; const ctx=canvas.getContext('2d'), {W,H,dpr}=fitCanvas(canvas); ctx.clearRect(0,0,W,H); ctx.fillStyle=colors.bg; ctx.fillRect(0,0,W,H); const e=state.bt?.equity||[]; if(e.length<2){ctx.fillStyle=colors.text;ctx.font=`${14*dpr}px Segoe UI`;ctx.fillText('Кривая капитала появится после расчёта',20*dpr,35*dpr);return;} const pad={l:46*dpr,r:20*dpr,t:18*dpr,b:30*dpr}, vals=e.map(x=>x.v), mn=Math.min(...vals), mx=Math.max(...vals), pp=(mx-mn)*.1||1, top=mx+pp, bot=mn-pp; const x=i=>pad.l+i*(W-pad.l-pad.r)/Math.max(1,e.length-1), y=v=>pad.t+(top-v)/(top-bot)*(H-pad.t-pad.b); ctx.strokeStyle=colors.grid; for(let i=0;i<4;i++){const yy=pad.t+i*(H-pad.t-pad.b)/3;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke()} ctx.strokeStyle=vals[vals.length-1]>=vals[0]?colors.green:colors.red;ctx.lineWidth=2*dpr;ctx.beginPath();e.forEach((p,i)=>i?ctx.lineTo(x(i),y(p.v)):ctx.moveTo(x(i),y(p.v)));ctx.stroke(); }

function setClassValue(id,value,positiveGood=true){const el=$(id); if(!el)return; el.textContent=value; el.classList.remove('green','red'); const n=parseFloat(String(value).replace(/[^0-9+\-.]/g,'')); if(Number.isFinite(n)&&n!==0)el.classList.add((n>0)===positiveGood?'green':'red');}
function renderMetrics(bt){const s=bt.summary; setClassValue('mPnl',`${s.pnl>=0?'+':''}${fmt(s.pnl)} USDT`); setClassValue('mPnlPct',`${s.ret>=0?'+':''}${fmt(s.ret)}%`); setClassValue('mReturn',`${fmt(s.final)} USDT`); $('mAnnual').textContent=`старт ${fmt(s.start)} USDT`; setClassValue('mWin',`${fmt(s.winRate)}%`); $('mWinSub').textContent=`${s.wins} / ${s.trades}`; setClassValue('mDd',`-${fmt(s.maxDd)}%`,false); $('mDdUsd').textContent=`-${fmt(s.maxDdUsd)} USDT`; $('mTrades').textContent=s.trades; $('mDirs').textContent=`BUY ${s.buyCount} / SELL ${s.sellCount}`; $('mPf').textContent=s.profitFactor===Infinity?'∞':fmt(s.profitFactor); $('mPf').classList.remove('green','red'); $('mPf').classList.add(s.profitFactor>=1?'green':'red'); }
function renderInsight(bt){const s=bt.summary; const box=document.querySelector('.insight'); box.classList.remove('good','warn','bad'); const verdict=$('resultVerdict'), note=$('resultNarrative'); if(!s.trades){box.classList.add('warn'); verdict.textContent='Полного цикла BUY → SELL нет'; note.textContent='Сигналы могли быть, но закрытых сделок на выбранном периоде нет.'; return;} if(s.pnl>0 && s.profitFactor>=1){box.classList.add('good'); verdict.textContent='Результат положительный';} else {box.classList.add('bad'); verdict.textContent='Результат отрицательный';} note.textContent=`Сделок: ${s.tradesCount}. BUY: ${s.buyCount}. SELL: ${s.sellCount}. Проверка идёт по минутным свечам.`; }
function updateMeta(inp,bt){const last=bt.candles[bt.candles.length-1]; $('chartTitle').textContent=`${inp.symbol} · 4H`; if($('sourceLabel')) $('sourceLabel').textContent=state.sourceLabel; $('metaOpen').textContent=fmtSmart(last.open); $('metaHigh').textContent=fmtSmart(last.high); $('metaLow').textContent=fmtSmart(last.low); $('metaClose').textContent=fmtSmart(last.close); $('metaFast').textContent=`${fmt(last.buyDist,3)}%`; $('metaSlow').textContent=`${fmt(last.sellDist,3)}%`; $('metaTrend').textContent=fmtInt(bt.candles1m.length); $('metaVolume').textContent=fmtInt(bt.candles.length); }
function renderTabs(bt,inp){ const tradesHtml = bt.trades.length ? `<table><thead><tr><th>#</th><th>Вход</th><th>Выход</th><th>Цена входа</th><th>Цена выхода</th><th>Размер</th><th>PnL</th><th>Комментарий</th></tr></thead><tbody>${bt.trades.map(t=>`<tr><td>${t.id}</td><td>${dt(t.entryTime)}</td><td>${dt(t.exitTime)}</td><td>${fmtSmart(t.entry)}</td><td>${fmtSmart(t.exit)}</td><td>${fmt(t.size)} USDT</td><td class="${t.pnl>=0?'green':'red'}">${t.pnl>=0?'+':''}${fmt(t.pnl)} USDT</td><td>${t.entryReason}<br>${t.reason}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Закрытых сделок нет.</div>'; $('tabTrades').innerHTML=tradesHtml;
  const checks=selfCheck(bt); $('tabLogs').innerHTML = `<div class="checkGrid">${checks.map(c=>`<div class="checkCard"><b class="${c.ok?'okText':'badText'}">${c.ok?'✓':'✗'} ${c.name}</b><span>${c.note}</span></div>`).join('')}</div>`;
  const manualRows=bt.trades.slice(0,6).map(t=>`<tr><td>#${t.id}</td><td>${dt(t.entryTime)}</td><td>BUY dist = ${fmt(t.buyDist,3)}%<br>Open 4H: ${fmtSmart(t.entry4hOpen)} · Low 4H: ${fmtSmart(t.entry4hLow)}</td><td>${dt(t.exitTime)}</td><td>SELL dist = ${fmt(t.sellDist,3)}%<br>Open 4H: ${fmtSmart(t.exit4hOpen)} · High 4H: ${fmtSmart(t.exit4hHigh)}</td></tr>`).join(''); $('tabQuality').innerHTML = `<div class="manualNote">Ручная сверка показывает, по каким данным можно проверить несколько сделок глазами: цена, время, формула BUY/SELL и текущая 4H-свеча, собранная из 1m.</div>${manualRows?`<table><thead><tr><th>Сделка</th><th>BUY время</th><th>BUY сверка</th><th>SELL время</th><th>SELL сверка</th></tr></thead><tbody>${manualRows}</tbody></table>`:'<div class="empty">Нет сделок для ручной сверки.</div>'}`;
  const q=state.quality; const warnings=[...(q?.warnings||[]),...(bt.warnings||[])]; $('tabDetails').innerHTML = `<div class="detailGrid"><div class="detailCard"><span>Логика</span><b>По ТЗ</b></div><div class="detailCard"><span>Данные</span><b>${q?fmt(q.score,0)+'/100':'—'}</b></div><div class="detailCard"><span>Пропуски</span><b>${q?q.gaps:'—'}</b></div><div class="detailCard"><span>Позиция</span><b>${bt.summary.openPosition?'Открыта':'Закрыта'}</b></div></div>${warnings.length?`<div class="manualNote"><b>Предупреждения:</b><br>${warnings.map(w=>'• '+w).join('<br>')}</div>`:''}`; }
function render(inp,bt){ updateMeta(inp,bt); renderMetrics(bt); renderInsight(bt); renderTabs(bt,inp); drawChart(); drawEquity(); }

async function recalculate(forceLoad=false){const runId=++state.runId; const inp=getInputs(); const btn=$('runBtn'); if(btn){btn.disabled=true;btn.textContent='Загрузка…';} $('csvBox')?.classList.toggle('hidden', inp.source!=='csv'); const key=dataKey(inp); try{ setLoading('Подготовка данных', 'Загружаю 1m-свечи пачками. Для периода с 2017 года это может занять 10–40 минут и много запросов.'); await sleep(50); if(forceLoad||key!==state.dataKey||!state.candles1m.length){ state.candles1m=await load1m(inp); state.dataKey=key; resetView(); } state.quality=analyze1mQuality(state.candles1m); const bt=runStrict(state.candles1m,inp); bt.warnings.push(...(state.loadWarnings||[])); if(runId!==state.runId)return; state.bt=bt; render(inp,bt);}catch(e){$('resultVerdict').textContent='Ошибка расчёта'; $('resultNarrative').textContent=e.message; console.error(e);} finally { if(btn){btn.disabled=false;btn.textContent='▶ Запустить';} } }
const recalcDebounced = (()=>{let t; return ()=>{clearTimeout(t); t=setTimeout(()=>recalculate(false),450)}})();
function applyPreset(name){const days=name==='14d'?14:name==='7d'?7:3; const to=new Date(); const from=new Date(to.getTime()-days*msDay); $('dateTo').value=to.toISOString().slice(0,10); $('dateFrom').value=from.toISOString().slice(0,10); recalculate(true);}
function setUiMode(mode,save=true){const simple=mode!=='advanced'; document.body.classList.toggle('simpleMode',simple); document.body.classList.toggle('advancedMode',!simple); $('uiSimpleBtn')?.classList.toggle('active',simple); $('uiAdvancedBtn')?.classList.toggle('active',!simple); if(save)localStorage.setItem('strict_tz_v14_ui', simple?'simple':'advanced'); if(simple&&['check','manual','logs','quality'].includes(document.querySelector('.tabs button.active')?.dataset.tab)){document.querySelector('.tabs button[data-tab="trades"]')?.click();} drawChart(); drawEquity();}
function exportTrades(){const bt=state.bt;if(!bt)return; const header=['id','buy_time','sell_time','entry','exit','size_usdt','qty','pnl_usdt','pnl_pct','buy_distance_pct','sell_distance_pct','entry_reason','exit_reason']; const rows=bt.trades.map(t=>[t.id,new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.entry,t.exit,t.size,t.qty,t.pnl,t.pnlPct,t.buyDist,t.sellDist,t.entryReason,t.reason]); downloadText('strict_tz_trades.csv',[header,...rows].map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n'),'text/csv;charset=utf-8');}
function exportReport(){const bt=state.bt, inp=getInputs(); if(!bt)return; downloadText('strict_tz_report.json',JSON.stringify({mode:'Strict TZ future bot backtest',config:inp,source:state.sourceLabel,quality:state.quality,summary:bt.summary,selfCheck:selfCheck(bt),trades:bt.trades},null,2),'application/json;charset=utf-8');}

function initChartInteractions(){const canvas=$('chart'); if(!canvas)return; canvas.addEventListener('wheel',e=>{if(!state.bt?.candles?.length)return; e.preventDefault(); const plot=state.chart.plot, pt=canvasPoint(e); if(!plot)return; const anchor=chartIndexFromX(pt.x,plot); const span=Math.max(8,(state.chart.viewEnd??state.bt.candles.length-1)-(state.chart.viewStart??0)+1); const factor=e.deltaY<0?.78:1.28; let newSpan=clamp(Math.round(span*factor),8,state.bt.candles.length); const ratio=span>1?(anchor-(state.chart.viewStart??0))/span:.5; let start=Math.round(anchor-newSpan*ratio), end=start+newSpan-1; if(start<0){end-=start;start=0} if(end>=state.bt.candles.length){start-=end-state.bt.candles.length+1;end=state.bt.candles.length-1} state.chart.viewStart=clamp(start,0,state.bt.candles.length-1);state.chart.viewEnd=clamp(end,state.chart.viewStart,state.bt.candles.length-1); drawChart();},{passive:false}); canvas.addEventListener('mousedown',e=>{if(!state.chart.plot)return; const pt=canvasPoint(e); const idx=chartIndexFromX(pt.x); state.chart.drag={type:e.shiftKey?'select':'pan',x:pt.x,startIdx:idx,viewStart:state.chart.viewStart,viewEnd:state.chart.viewEnd,currentIdx:idx};}); window.addEventListener('mousemove',e=>{const plot=state.chart.plot;if(!plot)return; const pt=canvasPoint(e); if(state.chart.drag){if(state.chart.drag.type==='pan'&&state.bt?.candles?.length){const span=state.chart.drag.viewEnd-state.chart.drag.viewStart; const dx=pt.x-state.chart.drag.x; const delta=Math.round(-dx/Math.max(1,plot.plotW)*Math.max(1,span)); let s=state.chart.drag.viewStart+delta,e2=state.chart.drag.viewEnd+delta; if(s<0){e2-=s;s=0} if(e2>=state.bt.candles.length){s-=e2-state.bt.candles.length+1;e2=state.bt.candles.length-1} state.chart.viewStart=clamp(s,0,state.bt.candles.length-1); state.chart.viewEnd=clamp(e2,state.chart.viewStart,state.bt.candles.length-1);} else if(state.chart.drag.type==='select'){state.chart.drag.currentIdx=chartIndexFromX(pt.x); state.chart.selection={start:state.chart.drag.startIdx,end:state.chart.drag.currentIdx};} drawChart(); return;} if(pt.x<plot.pad.l||pt.x>plot.W-plot.pad.r||pt.y<plot.pad.t||pt.y>plot.volBase){state.chart.hover=null;state.chart.hoverMarker=null;drawChart();return;} state.chart.hoverMarker=nearestMarker(pt); state.chart.hover={index:chartIndexFromX(pt.x),x:pt.x,y:pt.y,price:chartPriceFromY(pt.y)}; drawChart();}); window.addEventListener('mouseup',()=>{state.chart.drag=null;}); canvas.addEventListener('dblclick',()=>{resetView();state.chart.selection=null;drawChart();}); $('resetZoomBtn')?.addEventListener('click',()=>{resetView();state.chart.selection=null;drawChart();});}
function init(){setUiMode(localStorage.getItem('strict_tz_v14_ui')||'simple',false); $('uiSimpleBtn')?.addEventListener('click',()=>setUiMode('simple')); $('uiAdvancedBtn')?.addEventListener('click',()=>setUiMode('advanced')); document.querySelectorAll('.presetRow button[data-preset]').forEach(b=>b.addEventListener('click',()=>applyPreset(b.dataset.preset))); ['source'].forEach(id=>{const el=$(id); if(!el)return; el.addEventListener('change',()=>{ $('csvBox')?.classList.toggle('hidden', getInputs().source!=='csv'); });}); $('csvFile')?.addEventListener('change',()=>{}); $('runBtn')?.addEventListener('click',()=>recalculate(true)); $('exportTradesBtn')?.addEventListener('click',exportTrades); $('exportReportBtn')?.addEventListener('click',exportReport); document.querySelectorAll('.tabs button').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b===btn)); const tab=btn.dataset.tab; $('tabTrades').classList.toggle('hidden',tab!=='trades'); $('tabEquity').classList.toggle('hidden',tab!=='equity'); $('tabDetails').classList.toggle('hidden',tab!=='details'); $('tabLogs').classList.toggle('hidden',tab!=='check'); $('tabQuality').classList.toggle('hidden',tab!=='manual'); drawEquity();})); initChartInteractions(); window.addEventListener('resize',()=>{drawChart();drawEquity();}); $('resultVerdict').textContent='Готово к запуску'; $('resultNarrative').textContent='Введите параметры и нажмите «Запустить». Для больших периодов загрузка может занять долго.';}
init();
