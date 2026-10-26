'use strict';
/* ============================================================
 * K线之王 — 真实数据版（双主题 + 移动端优先）
 * ============================================================ */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* 主题颜色（canvas 无法读取 CSS 变量，故在 JS 中维护） */
const THEME = {
  light: { up:'#dc4c4c', dn:'#2faa6a', grid:'rgba(0,0,0,0.04)', ax:'#9ca3af', blue:'#2563eb', bg:'#ffffff', text:'#1a1a2e', panel:'#f5f6f8' },
  dark:  { up:'#ff453a', dn:'#30d158', grid:'rgba(255,255,255,0.04)', ax:'#636366', blue:'#0a84ff', bg:'#000000', text:'#ffffff', panel:'#1c1c1e' },
};
function tc() { return THEME[document.body.dataset.theme || 'light']; }

const CAPITAL = 1000000;
const FEE = { comm: 0.00025, minComm: 5, stamp: 0.0005, slip: 0.0002 };
const D_KEYS = ['ma5','ma10','ma20','ma60','dif','dea','macd','k','d','j','bmid','bup','blow','vma5','vma10'];
const W_KEYS = ['wma5','wma10','wma20','wma60','wdif','wdea','wmacd','wk','wd','wj','wbmid','wbup','wblow','wvma5','wvma10'];
const W_MAP  = { wma5:'ma5', wma10:'ma10', wma20:'ma20', wma60:'ma60', wdif:'dif', wdea:'dea',
                 wmacd:'macd', wk:'k', wd:'d', wj:'j', wbmid:'bmid', wbup:'bup', wblow:'blow',
                 wvma5:'vma5', wvma10:'vma10' };

let G = null;
const WK_CACHE = new Map();

/* ---------------- 题库懒加载 ----------------
 * 首屏仅预载 3-5 个数据文件（含每日一题标的所在文件），
 * 开始挑战即可玩；其余文件后台陆续加载，后续对局自动可用 */
const BANK = { loaded: new Set(), pending: new Map(), total: 0 };
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error('load fail: ' + src));
    document.body.appendChild(s);
  });
}
/* 幂等加载：加载中即登记 pending，杜绝与后台加载并发重复插入同一文件 */
function ensureFile(file) {
  if (BANK.loaded.has(file)) return Promise.resolve();
  if (BANK.pending.has(file)) return BANK.pending.get(file);
  const p = loadScript('data/' + file)
    .then(() => { BANK.loaded.add(file); BANK.pending.delete(file); })
    .catch(e => { BANK.pending.delete(file); throw e; });
  BANK.pending.set(file, p);
  return p;
}
async function initBank(dailyCode, onProgress) {
  const files = (window.QFILES || []).slice();
  BANK.total = files.length;
  if (!files.length) return;
  // 每日一题所在文件置顶
  if (dailyCode && window.QMANIFEST) {
    const hit = QMANIFEST.find(e => e.code === dailyCode);
    const idx = hit ? files.findIndex(f => f.file === hit.file) : -1;
    if (idx > 0) { const t = files[0]; files[0] = files[idx]; files[idx] = t; }
  }
  // 其余随机洗牌（每次进入预载不同的标的）
  for (let i = files.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i);
    const t = files[i]; files[i] = files[j]; files[j] = t;
  }
  const PRELOAD = Math.min(4, files.length);
  const preload = files.slice(0, PRELOAD);
  const rest = files.slice(PRELOAD);
  let done = 0;
  await Promise.all(preload.map(f =>
    ensureFile(f.file)
      .then(() => onProgress && onProgress(++done / PRELOAD))
      .catch(() => { onProgress && onProgress(++done / PRELOAD); })));
  // 后台加载剩余题目（限制并发 2，避免阻塞交互）
  (async () => {
    for (let i = 0; i < rest.length; i += 2) {
      await Promise.all(rest.slice(i, i + 2).map(f => ensureFile(f.file).catch(() => {})));
    }
  })();
}

/* ---------------- 格式化 ---------------- */
const fmtMoney = x => '¥' + x.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct   = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const fmtDate  = s  => { const t = String(s); return t.slice(4, 6) + '-' + t.slice(6, 8); };
const fmtFull  = s  => { const t = String(s); return t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8); };
/* 横坐标：1月显示年份（YYYY-01），其余月份 MM-DD */
const fmtAxis  = s  => { const t = String(s); return t.slice(4, 6) === '01' ? t.slice(0, 4) + '-01' : t.slice(4, 6) + '-' + t.slice(6, 8); };
const f2 = v => v == null ? '-' : v.toFixed(2);
const f3 = v => v == null ? '-' : v.toFixed(3);

/* ---------------- 交易引擎 ---------------- */
function calcBuy(cash, close) {
  const px = close * (1 + FEE.slip);
  let shares = Math.floor(cash / (px * 100)) * 100;
  while (shares >= 100) {
    const amount = shares * px;
    const fee = Math.max(FEE.minComm, amount * FEE.comm);
    if (amount + fee <= cash + 1e-9) return { shares, px, amount, fee, total: amount + fee };
    shares -= 100;
  }
  return null;
}
function calcSell(shares, close) {
  const px = close * (1 - FEE.slip);
  const amount = shares * px;
  const fee = Math.max(FEE.minComm, amount * FEE.comm) + amount * FEE.stamp;
  return { px, amount, fee, net: amount - fee };
}

/* ---------------- 分仓买卖 ----------------
 * 滑条 10%~100%（步长 10%）：买入 = 占当前现金的百分比；卖出 = 占当前持仓的百分比
 * 买入卖出均为 100 股整手（四舍五入到整手，不允许碎股；买入超出资金则向下取整）；
 * 卖出受 T+1 限制：当日买入部分不可卖 */
function posPct() { return (+($('#posPct').value || 100)) / 100; }
function sellableShares(bar) {
  if (!G || !G.shares) return 0;
  return bar.dayIdx > G.lastBuyDay ? G.shares : Math.max(0, G.shares - (G.todayBought || 0));
}
function buyQuote() {
  if (!G || G.over) return null;
  const bar = curBar();
  const budget = G.cash * posPct();
  const px = bar.close * (1 + FEE.slip);
  // 四舍五入到 100 股整手
  let shares = Math.round(budget / px / 100) * 100;
  while (shares >= 100) {
    const amount = shares * px;
    const fee = Math.max(FEE.minComm, amount * FEE.comm);
    if (amount + fee <= G.cash + 1e-9) return { shares, px, amount, fee, total: amount + fee };
    shares -= 100;
  }
  return null;
}
function sellQuote() {
  if (!G || G.over || !G.shares) return null;
  const bar = curBar();
  // 占总股本百分比，四舍五入到 100 股整手（不允许碎股）
  let qty = Math.round(G.shares * posPct() / 100) * 100;
  qty = Math.min(qty, sellableShares(bar));
  if (qty < 100) return null;
  const r = calcSell(qty, bar.close);
  r.qty = qty;
  return r;
}
function updatePosInfo() {
  const info = $('#posInfo'), lbl = $('#posPctLbl');
  if (!info) return;
  const pct = Math.round(posPct() * 100);
  lbl.textContent = pct + '%';
  if (!G || G.over) { info.textContent = '仓位 ' + pct + '%'; return; }
  const bq = buyQuote(), sq = sellQuote();
  const buyTxt = bq ? `买 ${fmtMoney(bq.amount)}/${bq.shares}股` : '买 不可买';
  const sellTxt = sq ? `卖 ${sq.qty}股/${fmtMoney(sq.amount)}` : '卖 不可卖';
  info.textContent = buyTxt + ' · ' + sellTxt;
}
(function selfTest() {
  const b = calcBuy(CAPITAL, 33.33);
  console.assert(b && b.shares % 100 === 0 && b.total <= CAPITAL + 1e-6, 'calcBuy fail');
})();

/* ---------------- 周线聚合 ---------------- */
function isoWeekKey(ymd) {
  const t = String(ymd);
  const y = +t.slice(0, 4), m = +t.slice(4, 6), d = +t.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const w = Math.ceil((((dt - ys) / 86400000) + 1) / 7);
  return dt.getUTCFullYear() * 100 + w;
}
function weeksOf(q) {
  if (WK_CACHE.has(q.code)) return WK_CACHE.get(q.code);
  const ws = [];
  let cur = null, key = -1;
  for (let i = 0; i < q.dates.length; i++) {
    const k = isoWeekKey(q.dates[i]);
    if (!cur || k !== key) {
      cur = { o: q.o[i], h: q.h[i], l: q.l[i], c: q.c[i], v: q.v[i], endDay: i };
      ws.push(cur); key = k;
    } else {
      if (q.h[i] > cur.h) cur.h = q.h[i];
      if (q.l[i] < cur.l) cur.l = q.l[i];
      cur.c = q.c[i]; cur.v += q.v[i]; cur.endDay = i;
    }
  }
  for (const w of ws) w.label = fmtDate(q.dates[w.endDay]);
  WK_CACHE.set(q.code, ws);
  return ws;
}

/* ---------------- 视图 ---------------- */
function getViewRange() {
  const total = G.freq === 'd' ? G.q.dates.length : weeksOf(G.q).length;
  const revealed = (G.freq === 'd' ? G.q.simStart : G.q.simStartW) + G.cursor;
  let end = Math.min(revealed, total);
  let start = Math.max(0, end - G.viewCount);
  return { start, end, total, revealed };
}

function makeView() {
  const q = G.q, ind = {};
  const { start, end } = getViewRange();
  const n = end - start;
  if (G.freq === 'd') {
    for (const k of D_KEYS) ind[k] = q.ind[k].slice(start, end);
    return { n, start, end,
      labels: q.dates.slice(start, end).map(fmtAxis),
      fullLabels: q.dates.slice(start, end).map(fmtFull),
      o: q.o.slice(start, end), h: q.h.slice(start, end), l: q.l.slice(start, end),
      c: q.c.slice(start, end), v: q.v.slice(start, end), ind };
  }
  const ws = weeksOf(q).slice(start, end);
  for (const k of W_KEYS) ind[W_MAP[k]] = q.ind[k].slice(start, end);
  return { n, start, end,
    labels: ws.map(w => fmtAxis(q.dates[w.endDay])),
    fullLabels: ws.map(w => '截至 ' + fmtFull(q.dates[w.endDay])),
    o: ws.map(w => w.o), h: ws.map(w => w.h), l: ws.map(w => w.l),
    c: ws.map(w => w.c), v: ws.map(w => w.v), ind };
}

function totalBars(q, freq) {
  return freq === 'd' ? q.dates.length - q.simStart : weeksOf(q).length - q.simStartW;
}
function curBar() {
  const q = G.q;
  if (G.freq === 'd') {
    const i = q.simStart + G.cursor - 1;
    return { i, dayIdx: i, close: q.c[i], label: fmtFull(q.dates[i]), date: q.dates[i] };
  }
  const ws = weeksOf(q);
  const i = q.simStartW + G.cursor - 1;
  return { i, dayIdx: ws[i].endDay, close: ws[i].c, label: '截至 ' + fmtFull(q.dates[ws[i].endDay]), date: q.dates[ws[i].endDay] };
}
function firstSimClose() {
  // 基准固定取起始日的日K收盘价，与周期无关（避免切换日/周K后基准跳变）
  return G.q.c[G.q.simStart];
}

/* ---------------- 画布绘图 ---------------- */
function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  let W = cv.clientWidth || cv.offsetWidth, H = cv.clientHeight || cv.offsetHeight;
  if (!W || !H) {
    const r = cv.getBoundingClientRect();
    W = Math.round(r.width); H = Math.round(r.height);
  }
  if (!W || !H) return null;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}
function drawLine(ctx, arr, xOf, yOf, col, w, dash) {
  if (!arr) return;
  ctx.strokeStyle = col; ctx.lineWidth = w || 1.2;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) { started = false; continue; }
    const x = xOf(i), y = yOf(v);
    if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
  }
  ctx.stroke(); ctx.setLineDash([]);
}

function drawChart(cv, vw, opts) {
  const colors = tc();
  const p = prepCanvas(cv); if (!p) return;
  const { ctx, W, H } = p;
  const n = vw.n; if (!n) return;
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
  const padR = 52, padB = 20, padT = 8, padL = 6;
  const pw = W - padR - padL;

  const showVol = opts.vol, showMacd = opts.macd, showKdj = opts.kdj;
  const subCount = (showVol ? 1 : 0) + (showMacd ? 1 : 0) + (showKdj ? 1 : 0);

  const mainRatio = subCount === 0 ? 0.94 : (subCount === 1 ? 0.74 : (subCount === 2 ? 0.60 : 0.50));
  const totalH = H - padT - padB;
  const mainH = totalH * mainRatio;
  const gapH = totalH * 0.02;
  const subH = subCount > 0 ? (totalH - mainH - gapH * subCount) / subCount : 0;

  const bw = pw / n, body = Math.max(1, Math.min(bw * 0.7, 18));
  const xOf = i => padL + i * bw + bw / 2;

  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < n; i++) { if (vw.h[i] > hi) hi = vw.h[i]; if (vw.l[i] < lo) lo = vw.l[i]; }
  if (opts.boll) {
    for (const a of [vw.ind.bup, vw.ind.blow]) {
      if (!a) continue;
      for (let i = 0; i < n; i++) {
        const v = a[i]; if (v == null) continue;
        if (v > hi) hi = v; if (v < lo) lo = v;
      }
    }
  }
  const pad = (hi - lo) * 0.06 || 1; hi += pad; lo -= pad;
  const yOf = v => padT + (hi - v) / (hi - lo) * mainH;

  /* 网格 */
  ctx.font = '10px ' + (document.body.dataset.theme === 'dark' ? 'monospace' : 'sans-serif');
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const pv = lo + (hi - lo) * g / 4, y = yOf(pv);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = colors.ax; ctx.fillText(pv.toFixed(2), W - padR + 4, y);
  }
  /* 日期 */
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) ctx.fillText(vw.labels[i], xOf(i), H - 9);

  /* K线 */
  for (let i = 0; i < n; i++) {
    const col = vw.c[i] >= vw.o[i] ? colors.up : colors.dn;
    const x = xOf(i);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x, yOf(vw.h[i])); ctx.lineTo(x, yOf(vw.l[i])); ctx.stroke();
    const yo = yOf(vw.o[i]), yc = yOf(vw.c[i]);
    const t = Math.min(yo, yc), h = Math.max(1, Math.abs(yo - yc));
    ctx.fillRect(x - body / 2, t, body, h);
  }

  /* BOLL */
  if (opts.boll && vw.ind.bup) {
    ctx.beginPath(); let st = false;
    for (let i = 0; i < n; i++) {
      const v = vw.ind.bup[i]; if (v == null) { st = false; continue; }
      const x = xOf(i), y = yOf(v);
      if (st) ctx.lineTo(x, y); else { ctx.moveTo(x, y); st = true; }
    }
    for (let i = n - 1; i >= 0; i--) {
      const v = vw.ind.blow[i]; if (v == null) continue;
      ctx.lineTo(xOf(i), yOf(v));
    }
    ctx.closePath(); ctx.fillStyle = colors.blue + '0a'; ctx.fill();
    drawLine(ctx, vw.ind.bup,  xOf, yOf, '#fb923c', 1);   // 上轨：橙
    drawLine(ctx, vw.ind.bmid, xOf, yOf, '#38bdf8', 1);   // 中轨：蓝
    drawLine(ctx, vw.ind.blow, xOf, yOf, '#a3e635', 1);   // 下轨：绿
  }
  /* MA */
  if (opts.ma) {
    drawLine(ctx, vw.ind.ma5,  xOf, yOf, colors.ax, 1);
    drawLine(ctx, vw.ind.ma10, xOf, yOf, '#f59e0b', 1);
    drawLine(ctx, vw.ind.ma20, xOf, yOf, '#a855f7', 1);
    drawLine(ctx, vw.ind.ma60, xOf, yOf, colors.blue, 1);
  }
  /* 最新价 */
  const lastC = vw.c[n - 1];
  ctx.strokeStyle = colors.blue + '80'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(padL, yOf(lastC)); ctx.lineTo(W - padR, yOf(lastC)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = lastC >= vw.o[n - 1] ? colors.up : colors.dn;
  ctx.fillRect(W - padR + 1, yOf(lastC) - 8, padR - 2, 16);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
  ctx.fillText(lastC.toFixed(2), W - padR / 2, yOf(lastC));

  /* 买卖标记 */
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const viewStart = vw.start;
  if (opts.freq === 'w') {
    const weekTrades = new Map();
    for (const t of (opts.markers || [])) {
      if (t.weekIdx === undefined) continue;
      if (!weekTrades.has(t.weekIdx)) weekTrades.set(t.weekIdx, []);
      weekTrades.get(t.weekIdx).push(t);
    }
    ctx.font = 'bold 9px sans-serif';
    for (const [wi, ts] of weekTrades) {
      const vi = wi - viewStart;
      if (vi < 0 || vi >= n) continue;
      const x = xOf(vi);
      const y = yOf(vw.l[vi]) + 12;
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000000'; ctx.fillText('T', x, y + 0.5);
      for (const t of ts) {
        if (t.freq === 'w') {
          const yy = t.type === 'buy' ? yOf(vw.l[vi]) + 24 : yOf(vw.h[vi]) - 12;
          ctx.fillStyle = t.type === 'buy' ? colors.up : colors.dn;
          ctx.beginPath(); ctx.arc(x, yy, 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(t.type === 'buy' ? 'B' : 'S', x, yy + 0.5);
        }
      }
    }
  } else {
    for (const t of (opts.markers || [])) {
      // 日K视图用绝对日索引定位（周K模式下的交易落在该周最后一个交易日）
      const vi = (t.day !== undefined ? t.day : t.bar) - viewStart;
      if (vi < 0 || vi >= n) continue;
      const x = xOf(vi);
      ctx.font = 'bold 9px sans-serif';
      if (t.type === 'buy') {
        const y = yOf(vw.l[vi]) + 12;
        ctx.fillStyle = colors.up; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.fillText('B', x, y + 0.5);
      } else {
        const y = yOf(vw.h[vi]) - 12;
        ctx.fillStyle = colors.dn; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.fillText('S', x, y + 0.5);
      }
    }
  }
  ctx.font = '10px sans-serif';

  /* 副图 */
  let subY = padT + mainH + gapH;

  if (showVol) {
    let vmax = 0;
    for (let i = 0; i < n; i++) if (vw.v[i] > vmax) vmax = vw.v[i];
    const yv = v => subY + subH - v / (vmax || 1) * (subH - 2);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, subY); ctx.lineTo(W - padR, subY); ctx.stroke();
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = vw.c[i] >= vw.o[i] ? colors.up : colors.dn;
      ctx.fillRect(xOf(i) - body / 2, yv(vw.v[i]), body, subY + subH - yv(vw.v[i]));
    }
    subY += subH + gapH;
  }

  if (showMacd) {
    let mm = 0;
    for (let i = 0; i < n; i++) for (const kk of ['dif', 'dea', 'macd']) {
      const v = vw.ind[kk][i]; if (v != null && Math.abs(v) > mm) mm = Math.abs(v);
    }
    mm = mm || 1;
    const ym = v => subY + subH / 2 - v / mm * (subH / 2 - 2);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, subY); ctx.lineTo(W - padR, subY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, ym(0)); ctx.lineTo(W - padR, ym(0)); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const v = vw.ind.macd[i]; if (v == null) continue;
      ctx.fillStyle = v >= 0 ? colors.up : colors.dn;
      const y0 = ym(0), y1 = ym(v);
      ctx.fillRect(xOf(i) - body / 2, Math.min(y0, y1), body, Math.max(1, Math.abs(y1 - y0)));
    }
    drawLine(ctx, vw.ind.dif, xOf, ym, colors.ax, 1);
    drawLine(ctx, vw.ind.dea, xOf, ym, '#f59e0b', 1);
    subY += subH + gapH;
  }

  if (showKdj) {
    // KDJ 的 J 值可超出 [0,100]，clamp 防止画出副图区域
    const yk = v => subY + subH - Math.max(0, Math.min(100, v)) / 100 * (subH - 4) - 2;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath(); ctx.moveTo(padL, subY); ctx.lineTo(W - padR, subY); ctx.stroke();
    for (const lv of [20, 50, 80]) {
      ctx.beginPath(); ctx.moveTo(padL, yk(lv)); ctx.lineTo(W - padR, yk(lv)); ctx.stroke();
    }
    drawLine(ctx, vw.ind.k, xOf, yk, colors.ax, 1);
    drawLine(ctx, vw.ind.d, xOf, yk, '#f59e0b', 1);
    drawLine(ctx, vw.ind.j, xOf, yk, '#a855f7', 1);
  }

  /* 十字光标 */
  if (opts.cross && opts.cross.x > padL && opts.cross.x < W - padR) {
    const i = Math.min(n - 1, Math.max(0, Math.round((opts.cross.x - padL - bw / 2) / bw)));
    const x = xOf(i);
    ctx.strokeStyle = colors.ax + '66'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    if (opts.cross.y > padT && opts.cross.y < padT + mainH) {
      ctx.beginPath(); ctx.moveTo(padL, opts.cross.y); ctx.lineTo(W - padR, opts.cross.y); ctx.stroke();
      const pv = hi - (opts.cross.y - padT) / mainH * (hi - lo);
      ctx.setLineDash([]);
      ctx.fillStyle = colors.panel;
      ctx.fillRect(W - padR + 1, opts.cross.y - 8, padR - 2, 16);
      ctx.fillStyle = colors.text; ctx.textAlign = 'center';
      ctx.fillText(pv.toFixed(2), W - padR / 2, opts.cross.y);
    }
    ctx.setLineDash([]);
    if (opts.tip) showTip(vw, i, opts.cross);
  } else if (opts.tip) {
    opts.tip.classList.remove('show');
  }
}

function showTip(vw, i, cross) {
  const tip = $('#tip');
  const rows = [
    [vw.fullLabels[i]],
    [`${vw.o[i].toFixed(2)} / ${vw.h[i].toFixed(2)} / ${vw.l[i].toFixed(2)} / ${vw.c[i].toFixed(2)}`],
    [`${fmtPct(vw.c[i] / vw.o[i] - 1)}`],
  ];
  if (vw.ind.ma5 && vw.ind.ma5[i] != null)
    rows.push([`MA ${f2(vw.ind.ma5[i])} / ${f2(vw.ind.ma10[i])} / ${f2(vw.ind.ma20[i])}`]);
  if (vw.ind.dif && vw.ind.dif[i] != null)
    rows.push([`MACD ${f3(vw.ind.dif[i])} / ${f3(vw.ind.dea[i])}`]);
  tip.innerHTML = rows.map(r => `<div>${r[0]}</div>`).join('');
  tip.classList.add('show');
  const wrap = $('#chartWrap');
  let x = cross.mx + 12, y = cross.my + 8;
  if (x + tip.offsetWidth > wrap.clientWidth - 4) x = cross.mx - tip.offsetWidth - 12;
  if (y + tip.offsetHeight > wrap.clientHeight - 4) y = wrap.clientHeight - tip.offsetHeight - 4;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

/* ---------------- 每日一题 ---------------- */
let DAILY = null;
function renderDailyCard() {
  const card = $('#dailyCard');
  if (!card) return;
  if (!DAILY || !DAILY.code) { card.style.display = 'none'; return; }
  card.style.display = '';
  const ds = DAILY.date;
  $('#dailyDate').textContent = ds.slice(0, 4) + '-' + ds.slice(4, 6) + '-' + ds.slice(6, 8);
  $('#dailyName').textContent = DAILY.name + ' ' + DAILY.code;
  const st = $('#dailyStatus');
  if (DAILY.myBest) st.textContent = `今日已挑战 ${DAILY.myBest.plays} 次 · 最佳 ${fmtPct(DAILY.myBest.ret)} ${DAILY.myBest.rating}`;
  else st.textContent = '所有玩家同题竞技 · 今日尚未挑战';
  const btn = $('#btnDaily');
  btn.disabled = false;
  btn.textContent = '开始挑战';
}

async function refreshDaily() {
  try { DAILY = await (await fetch('/api/daily')).json(); } catch (e) {}
  renderDailyCard();
}

function startDaily() {
  if (!DAILY) return;
  const q = (window.QBANK || []).find(x => x.code === DAILY.code);
  if (!q) {
    const hit = window.QMANIFEST && QMANIFEST.find(e => e.code === DAILY.code);
    if (hit) {
      toast('题目加载中…');
      ensureFile(hit.file)
        .then(() => startDaily())
        .catch(() => toast('加载失败，请检查网络'));
    } else toast('题目未就绪，请稍候');
    return;
  }
  startGame({ fixedQ: q, mode: 'daily' });
}

/* ---------------- 对局流程 ---------------- */
function startGame(opts) {
  opts = opts || {};
  if (!window.QBANK || !QBANK.length) { alert('题库未加载'); return; }
  const type = $('#selType').value;
  // 每日一题强制日K，保证所有玩家同口径竞技
  const freq = opts.mode === 'daily' ? 'd' : $('#selFreq').value;
  const showBtn = document.querySelector('.toggle-group button.on');
  const showName = showBtn ? showBtn.dataset.show === '1' : true;
  let q = opts.fixedQ || null;
  if (!q) {
    const seen = new Set();
    const pool = QBANK.filter(q => (type === 'mix' || q.type === type) && !seen.has(q.code) && seen.add(q.code));
    if (!pool.length) { alert('该类型暂无题目，请稍候（题库仍在后台加载）'); return; }
    q = pool[Math.floor(Math.random() * pool.length)];
  }

  const totalData = freq === 'd' ? q.dates.length : weeksOf(q).length;

  const slider = $('#posPct'); if (slider) slider.value = 100; // 每局仓位重置为 100%
  G = { q, freq, cursor: 1, cash: CAPITAL, shares: 0, costBasis: 0, lastBuyDay: -1, todayBought: 0,
        trades: [], equity: [], bh: [], cross: null, over: false,
        simLen: totalBars(q, freq),
        viewCount: Math.min(80, totalData),
        showName: showName,
        mode: opts.mode === 'daily' ? 'daily' : 'free',
        dailyId: opts.mode === 'daily' && DAILY ? DAILY.date : null,
        indicators: { ma: true, boll: true, vol: true, macd: true, kdj: true } };

  if (!showName) $('#hName').textContent = '******';
  else $('#hName').textContent = q.name + ' ' + q.code;

  $('#tradeDrawer').classList.remove('open');
  $('#startScreen').classList.add('hidden');
  $('#endScreen').classList.add('hidden');
  $('#gameScreen').classList.remove('hidden');
  renderHUD(); renderTrades(); updateControls(); updateToolbar(); updateFreqBtn();
  requestAnimationFrame(() => requestAnimationFrame(renderChart));
  toast('挑战开始');
}

function act(type) {
  if (!G || G.over) return;
  const bar = curBar();
  if (type === 'buy') {
    const r = buyQuote();
    if (!r) { toast('现金不足，无法按该仓位买入'); return; }
    G.cash = +(G.cash - r.total).toFixed(2);
    // 加仓：累计成本；同日买入计入 T+1 锁定
    if (bar.dayIdx === G.lastBuyDay) G.todayBought = (G.todayBought || 0) + r.shares;
    else { G.lastBuyDay = bar.dayIdx; G.todayBought = r.shares; }
    G.shares += r.shares; G.costBasis = +(G.costBasis + r.total).toFixed(2);
    const weekIdx = G.freq === 'w' ? bar.i : getWeekIdxForBar(bar.dayIdx);
    G.trades.push({ type: 'buy', bar: bar.i, day: bar.dayIdx, weekIdx, freq: G.freq, price: r.px, shares: r.shares, fee: r.fee, label: bar.label });
  } else if (type === 'sell') {
    if (!G.shares) { toast('空仓'); return; }
    const r = sellQuote();
    if (!r) { toast(bar.dayIdx <= G.lastBuyDay ? 'T+1 不可卖出' : '卖出不足一手（100股）'); return; }
    // 按比例结转成本，计算本笔盈亏
    const costPortion = G.costBasis * r.qty / G.shares;
    G.cash = +(G.cash + r.net).toFixed(2);
    const pnl = +(r.net - costPortion).toFixed(2);
    const weekIdx = G.freq === 'w' ? bar.i : getWeekIdxForBar(bar.dayIdx);
    G.trades.push({ type: 'sell', bar: bar.i, day: bar.dayIdx, weekIdx, freq: G.freq, price: r.px, shares: r.qty, fee: r.fee,
                    label: bar.label, pnl, pnlPct: pnl / costPortion });
    G.shares -= r.qty;
    G.costBasis = +(G.costBasis - costPortion).toFixed(2);
    if (G.shares === 0) { G.costBasis = 0; G.todayBought = 0; }
  }
  G.equity.push(+(G.cash + G.shares * bar.close).toFixed(2));
  G.bh.push(+(CAPITAL * bar.close / firstSimClose()).toFixed(2));
  G.cursor++;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (G.cursor > G.simLen) finish(bar);
  else { renderHUD(); renderTrades(); renderChart(); updateControls(); }
}

function getWeekIdxForBar(dayIdx) {
  const ws = weeksOf(G.q);
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].endDay >= dayIdx) return i;
  }
  return ws.length - 1;
}

function toggleFreq() {
  if (!G || G.over) return;
  if (G.mode === 'daily') { toast('每日一题固定日K，保证同口径竞技'); return; }
  G.freq = G.freq === 'd' ? 'w' : 'd';
  const ws = weeksOf(G.q);
  if (G.freq === 'w') {
    const currentDay = G.q.simStart + G.cursor - 1;
    let weekCursor = 0;
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].endDay >= currentDay) {
        // 当前周未完结时其周K聚合了未来数据（前视泄露），只揭示到上一完整周
        weekCursor = (ws[i].endDay === currentDay ? i : i - 1) - G.q.simStartW + 1;
        break;
      }
    }
    G.cursor = Math.max(1, weekCursor);
    G.simLen = ws.length - G.q.simStartW;
  } else {
    const currentWeek = G.q.simStartW + G.cursor - 1;
    const dayCursor = ws[currentWeek].endDay - G.q.simStart + 1;
    G.cursor = Math.max(1, dayCursor);
    G.simLen = G.q.dates.length - G.q.simStart;
  }
  const totalData = G.freq === 'd' ? G.q.dates.length : weeksOf(G.q).length;
  G.viewCount = Math.min(80, totalData);
  updateFreqBtn();
  renderHUD(); renderChart(); updateControls();
}

function updateFreqBtn() {
  const btn = $('#btnFreq');
  btn.textContent = G.freq === 'd' ? '⇄ 周K' : '⇄ 日K';
}

function finish(lastBar) {
  G.over = true;
  $('#hName').textContent = G.q.name + ' ' + G.q.code;
  // 结算揭晓标的（即使挑战时选择了隐藏）
  $('#endStock').innerHTML = `本局标的：<b>${G.q.name}</b><span class="code">${G.q.code}</span>` +
    (G.showName ? '' : '<span class="code">（挑战中已隐藏）</span>');
  const finalEq = +(G.cash + G.shares * lastBar.close).toFixed(2);
  const ret = finalEq / CAPITAL - 1;
  const bh = lastBar.close / firstSimClose() - 1;
  const excess = ret - bh;
  const dd = maxDrawdown(G.equity);
  const sells = G.trades.filter(t => t.type === 'sell');
  const wr = sells.length ? sells.filter(t => t.pnl > 0).length / sells.length : null;
  const rating = rate(excess, dd);
  saveRecord({ ts: Date.now(), type: G.q.type, freq: G.freq,
               ret, bh, excess, rating, trades: G.trades.length });
  lastR = { finalEq, ret, bh, excess, dd, sellCount: sells.length, wr, rating };
  renderReport(lastR);
  setupEndLeaderboard(lastR);
  $('#endScreen').classList.remove('hidden');
  requestAnimationFrame(() => { renderReportCharts(); });
}

function maxDrawdown(eq) {
  let peak = -Infinity, mdd = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    if (peak > 0) { const d = (peak - v) / peak; if (d > mdd) mdd = d; }
  }
  return mdd;
}
function rate(excess, dd) {
  if (excess >= 0.25 && dd <= 0.20) return 'S';
  if (excess >= 0.10) return 'A';
  if (excess >= 0.00) return 'B';
  if (excess >= -0.15) return 'C';
  return 'D';
}

/* ---------------- Markdown 渲染（极简，无依赖） ---------------- */
function mdToHtml(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*] (.*$)/gim, '<li>$1</li>');
  // 包裹连续的 li
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>');
  // 包裹连续的 blockquote
  html = html.replace(/(<blockquote>.*<\/blockquote>\n?)+/g, m => '<blockquote>' + m.replace(/<\/?blockquote>/g, '') + '</blockquote>');
  // 段落
  html = html.split(/\n\n+/).map(p => {
    p = p.trim();
    if (!p || /^<[hlu]/.test(p)) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  return html;
}

/* ---------------- AI 报告卡片渲染 ---------------- */
function mdInline(t) {
  return String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function mdBodyHtml(body) {
  const lines = body.split('\n');
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line)) continue;
    const lm = /^[-*]\s+(.*)$/.exec(line);
    if (lm) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + mdInline(lm[1]) + '</li>'; continue; }
    if (/^#{1,4}\s/.test(line)) { closeList(); html += '<p><strong>' + mdInline(line.replace(/^#+\s*/, '')) + '</strong></p>'; continue; }
    if (/^>\s?/.test(line)) { closeList(); html += '<p><em>' + mdInline(line.replace(/^>\s?/, '')) + '</em></p>'; continue; }
    closeList();
    html += '<p>' + mdInline(line) + '</p>';
  }
  closeList();
  return html;
}
function renderAiReport(md) {
  if (!md) return '<p>暂无分析内容</p>';
  const secs = md.split(/\n##\s+/);
  let html = '';
  const bqm = /^>\s?(.+)$/m.exec(secs[0]);
  if (bqm) html += '<div class="ai-banner">' + mdInline(bqm[1]) + '</div>';
  if (secs.length <= 1) return html + mdBodyHtml(md);   // 无分节时兜底
  for (let i = 1; i < secs.length; i++) {
    const nl = secs[i].indexOf('\n');
    const title = nl < 0 ? secs[i] : secs[i].slice(0, nl);
    const body = nl < 0 ? '' : secs[i].slice(nl + 1);
    html += '<div class="ai-card"><div class="ai-card-title">' + mdInline(title) +
            '</div>' + mdBodyHtml(body) + '</div>';
  }
  return html;
}

/* ---------------- AI 分析 ---------------- */
async function requestAIAnalysis() {
  const btn = $('#btnAI');
  const content = $('#aiContent');
  btn.disabled = true;
  btn.textContent = '分析中...';
  content.innerHTML = '<p>正在分析交易记录...</p>';
  content.classList.add('loading');
  try {
    const stats = {
      ret: G.equity.length ? (G.equity[G.equity.length-1] / CAPITAL - 1) : 0,
      bh: G.bh.length ? (G.bh[G.bh.length-1] / CAPITAL - 1) : 0,
      excess: 0, dd: maxDrawdown(G.equity), trades: G.trades.length
    };
    stats.excess = stats.ret - stats.bh;
    // 挑战区间（开始挑战→结束挑战）的行情序列，AI 仅允许分析该跨度
    const q = G.q, s = q.simStart, e = Math.min(q.dates.length - 1, s + G.simLen - 1);
    stats.startDate = q.dates[s]; stats.endDate = q.dates[e]; stats.days = e - s + 1;
    stats.freq = G.freq;
    const kline = [];
    for (let i = s; i <= e; i++) kline.push([q.dates[i], q.o[i], q.h[i], q.l[i], q.c[i]]);
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades: G.trades, stats: stats, kline })
    });
    if (!response.ok) throw new Error('分析服务暂不可用');
    const data = await response.json();
    content.innerHTML = renderAiReport(data.analysis);
    content.classList.remove('loading'); content.classList.remove('dim');
  } catch (e) {
    content.innerHTML = '<p>AI 分析服务暂不可用，请稍后再试。</p><p>' + e.message + '</p>';
    content.classList.remove('loading'); content.classList.remove('dim');
  }
  btn.disabled = false;
  btn.textContent = '重新分析';
}

/* ---------------- 渲染 ---------------- */
function renderHUD() {
  const q = G.q, bar = curBar();
  const mkt = G.shares * bar.close;
  const total = G.cash + mkt;
  const ret = total / CAPITAL - 1;
  if (G.showName) $('#hName').textContent = q.name + ' ' + q.code;
  else $('#hName').textContent = '******';
  $('#hType').textContent = (q.type === 'stock' ? '个股' : 'ETF') + (G.mode === 'daily' ? '·每日一题' : '');
  $('#hFreq').textContent = G.freq === 'd' ? '日K' : '周K';
  $('#hTotal').textContent = fmtMoney(total);
  $('#hSplit').textContent = `现金 ${fmtMoney(G.cash)} · 股票 ${fmtMoney(mkt)}`;
  const rEl = $('#hRet');
  rEl.textContent = fmtPct(ret);
  rEl.className = 'num ' + (ret >= 0 ? 'pos' : 'neg');
  $('#hHold').textContent = G.shares ? '持' + (bar.dayIdx - G.lastBuyDay) + '天' : '空仓';
  $('#progress').textContent = `${Math.min(G.cursor, G.simLen)}/${G.simLen}`;
  updatePosInfo();
}

function drawMiniEq(id) {
  const cv = $(id); if (!cv) return;
  const p = prepCanvas(cv); if (!p) return;
  const { ctx, W, H } = p;
  const colors = tc();
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
  const eq = G.equity;
  if (!eq.length) {
    ctx.fillStyle = colors.ax; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无收益数据', W / 2, H / 2 + 3);
    return;
  }
  const vals = [CAPITAL, ...eq];
  let hi = Math.max(...vals), lo = Math.min(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padR = 34, padT = 12;   // 右侧留纵坐标，顶部留标题
  const xOf = i => 3 + i / (vals.length - 1) * (W - 6 - padR);
  const yOf = v => padT + (hi - v) / (hi - lo) * (H - padT - 3);
  /* 本金基准线 */
  ctx.strokeStyle = colors.grid; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(3, yOf(CAPITAL)); ctx.lineTo(W - padR, yOf(CAPITAL)); ctx.stroke();
  ctx.setLineDash([]);
  /* 标题 + 纵坐标刻度 */
  ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = colors.ax;
  ctx.fillText('收益曲线', 3, 6);
  ctx.textAlign = 'left';
  ctx.fillText(fmtPct(hi / CAPITAL - 1), W - padR + 3, yOf(hi));
  ctx.fillText(fmtPct(lo / CAPITAL - 1), W - padR + 3, yOf(lo));
  /* 曲线 */
  ctx.strokeStyle = eq[eq.length - 1] >= CAPITAL ? colors.up : colors.dn;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  vals.forEach((v, i) => i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)));
  ctx.stroke();
}

function renderTrades() {
  const html = !G.trades.length
    ? '<li class="dim">暂无交易</li>'
    : G.trades.slice().reverse().map(t => {
        const head = t.type === 'buy'
          ? `<b class="pos">B</b> ${t.label.slice(5)} @ ${t.price.toFixed(2)}`
          : `<b class="neg">S</b> ${t.label.slice(5)} @ ${t.price.toFixed(2)} <span class="${t.pnl >= 0 ? 'pos' : 'neg'}">${fmtPct(t.pnlPct)}</span>`;
        return `<li>${head}</li>`;
      }).join('');
  $('#tradeList').innerHTML = html;
  const drawer = $('#tradeListDrawer');
  if (drawer) drawer.innerHTML = html;
  drawMiniEq('#miniEq');
  drawMiniEq('#miniEqDrawer');
}

function updateControls() {
  const a = $('#btnA'), b = $('#btnB'), c = $('#btnC');
  a.disabled = !buyQuote();              // 买入（分仓，可加仓）
  b.disabled = !sellQuote();             // 卖出（分仓，T+1 内锁定部分不可卖）
  if (c) c.disabled = false;             // 观望
  updatePosInfo();
}

function updateToolbar() {
  $$('.toolbar-btn[data-ind]').forEach(btn => {
    const ind = btn.dataset.ind;
    btn.classList.toggle('on', G.indicators[ind]);
  });
}

function renderChart() {
  if (!G) return;
  const vw = makeView();
  const ind = G.indicators;
  drawChart($('#chart'), vw, {
    ma: ind.ma, boll: ind.boll, vol: ind.vol, macd: ind.macd, kdj: ind.kdj,
    markers: G.trades, cross: G.cross, tip: $('#tip'), freq: G.freq
  });
}

/* ---------------- 滚轮缩放 ---------------- */
function handleZoom(delta) {
  if (!G || G.over) return;
  const totalData = G.freq === 'd' ? G.q.dates.length : weeksOf(G.q).length;
  const revealed = (G.freq === 'd' ? G.q.simStart : G.q.simStartW) + G.cursor;
  const maxCount = Math.min(revealed, totalData);
  const minCount = 20;
  const step = Math.max(2, Math.round(G.viewCount * 0.15));
  if (delta < 0) G.viewCount = Math.max(minCount, G.viewCount - step);
  else G.viewCount = Math.min(maxCount, G.viewCount + step);
  renderChart();
}

/* ---------------- 结算 ---------------- */
function renderReport(R) {
  const colors = tc();
  const cells = [
    ['收益率', fmtPct(R.ret), R.ret >= 0 ? 'pos' : 'neg'],
    ['基准', fmtPct(R.bh), ''],
    ['超额', fmtPct(R.excess), R.excess >= 0 ? 'pos' : 'neg'],
    ['回撤', fmtPct(-R.dd), R.dd > 0.25 ? 'neg' : ''],
    ['笔数', String(G.trades.length), ''],
    ['胜率', R.wr == null ? '—' : (R.wr * 100).toFixed(0) + '%', ''],
  ];
  $('#endStats').innerHTML = cells.map(c =>
    `<div class="cell"><span>${c[0]}</span><b class="${c[2]}">${c[1]}</b></div>`).join('');
  const rEl = $('#rating');
  rEl.textContent = R.rating;
  rEl.style.color = { S: '#f59e0b', A: colors.up, B: colors.blue, C: colors.ax, D: colors.dn }[R.rating];

  let roundNo = 0;
  let html = '<tr><th>#</th><th>操作</th><th>时间</th><th>价格</th><th>盈亏</th></tr>';
  for (const t of G.trades) {
    if (t.type === 'buy') roundNo++;
    html += `<tr><td>${roundNo}</td>` +
      `<td class="${t.type === 'buy' ? 'pos' : 'neg'}">${t.type === 'buy' ? '买入' : '卖出'}</td>` +
      `<td>${t.label}</td><td>${t.price.toFixed(2)}</td>` +
      `<td class="${t.pnl == null ? '' : (t.pnl >= 0 ? 'pos' : 'neg')}">${t.pnl == null ? '—' : fmtPct(t.pnlPct)}</td></tr>`;
  }
  $('#tradeTable').innerHTML = html;

  $('#aiContent').textContent = '点击下方按钮获取 AI 分析';
  $('#aiContent').classList.add('dim');
  $('#btnAI').textContent = '获取 AI 分析';
  $('#btnAI').disabled = false;
}

function renderReportCharts() {
  const colors = tc();
  const totalN = G.freq === 'd' ? G.q.dates.length : weeksOf(G.q).length;
  const savedCount = G.viewCount;
  G.viewCount = totalN;
  const vw = makeView();
  drawChart($('#replayChart'), vw, {
    ma: true, boll: true, vol: true, macd: true, kdj: true,
    markers: G.trades, freq: G.freq
  });
  G.viewCount = savedCount;

  const cv = $('#eqChart'); const p = prepCanvas(cv); if (!p) return;
  const { ctx, W, H } = p;
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
  const eq = G.equity, bh = G.bh, n = eq.length;
  if (!n) return;
  let hi = Math.max(...eq, ...bh), lo = Math.min(...eq, ...bh);
  const pad = (hi - lo) * 0.08 || 1; hi += pad; lo -= pad;
  const xOf = i => 8 + i / (n - 1) * (W - 70);
  const yOf = v => 4 + (hi - v) / (hi - lo) * (H - 20);
  ctx.strokeStyle = colors.grid; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(8, yOf(CAPITAL)); ctx.lineTo(W - 62, yOf(CAPITAL)); ctx.stroke();
  ctx.setLineDash([]);
  const poly = (arr, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
    arr.forEach((v, i) => i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)));
    ctx.stroke();
  };
  poly(eq, '#f59e0b'); poly(bh, colors.ax);
  ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f59e0b'; ctx.fillText('YOU', W - 56, 14);
  ctx.fillStyle = colors.ax; ctx.fillText('B&H', W - 56, 32);
  ctx.fillStyle = eq[n - 1] >= CAPITAL ? colors.up : colors.dn;
  ctx.fillText(fmtPct(eq[n - 1] / CAPITAL - 1), W - 56, 50);
  ctx.fillStyle = colors.ax;
  ctx.fillText(fmtPct(bh[n - 1] / CAPITAL - 1), W - 56, 66);
}

/* ---------------- 战绩记录 ---------------- */
const REC_KEY = 'klt_records_v3';
function loadRecords() {
  try { return JSON.parse(localStorage.getItem(REC_KEY)) || []; } catch (e) { return []; }
}
function saveRecord(r) {
  try {
    const rs = loadRecords();
    rs.unshift(r);
    localStorage.setItem(REC_KEY, JSON.stringify(rs.slice(0, 50)));
  } catch (e) {}
}
/* ---------------- 排行榜 ---------------- */
const LB_NAME_KEY = 'klt_name';
let lbSubmitted = false;   // 每局只能提交一次
let lbMyTs = 0;            // 自己上榜记录的 ts，用于高亮
let lastR = null;          // 最近一局的结算数据

function lbRowHtml(e, meTs) {
  const isMe = meTs && e.ts === meTs;
  const rc = e.rank <= 3 ? ' r' + e.rank : '';
  const stock = e.stockName ? `${e.stockName}·` : '';
  return `<div class="lb-row${isMe ? ' me' : ''}">` +
    `<span class="lb-rank${rc}">${e.rank}</span>` +
    `<span class="lb-name">${e.name}</span>` +
    `<span class="lb-meta">${stock}${e.type === 'stock' ? '个股' : 'ETF'}·${e.freq === 'd' ? '日K' : '周K'}·${e.trades}笔</span>` +
    `<span class="lb-ret ${e.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(e.ret)}</span>` +
    `<span class="lb-rating">${e.rating}</span></div>`;
}

async function fetchLeaderboard() {
  const r = await fetch('/api/leaderboard');
  if (!r.ok) throw new Error('榜单服务不可用');
  return r.json();
}

/* ---------------- 最近战绩独立界面（登录后可见，数据来自服务端） ---------------- */
async function openRecScreen() {
  if (!AUTH.loggedIn) {
    toast('登录后可查看最近战绩');
    openLogin();
    return;
  }
  const el = $('#recFull');
  el.innerHTML = '<div class="lb-empty">加载中…</div>';
  $('#recScreen').classList.remove('hidden');
  try {
    const r = await fetch('/api/me/records');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '加载失败');
    const rs = d.records || [];
    if (!rs.length) {
      el.innerHTML = '<div class="lb-empty">暂无战绩，去玩一局吧</div>';
      return;
    }
    el.innerHTML = rs.map(x => {
      const d2 = new Date(x.ts);
      const ds = `${d2.getMonth() + 1}-${d2.getDate()} ${String(d2.getHours()).padStart(2, '0')}:${String(d2.getMinutes()).padStart(2, '0')}`;
      return `<div class="lb-row">` +
        `<span class="lb-date">${ds}</span>` +
        `<span class="lb-name">${x.type === 'stock' ? '个股' : 'ETF'} · ${x.freq === 'd' ? '日K' : '周K'} · ${x.trades}笔</span>` +
        `<span class="lb-ret ${x.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(x.ret)}</span>` +
        `<span class="lb-rating">${x.rating}</span></div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="lb-empty">战绩加载失败，请稍后再试</div>';
  }
}

async function loadEndLeaderboard() {
  const el = $('#lbList');
  try {
    const data = await fetchLeaderboard();
    if (!data.top || !data.top.length) {
      el.innerHTML = '<div class="lb-empty">暂无上榜记录</div>';
      return;
    }
    el.innerHTML = data.top.slice(0, 10).map(e => lbRowHtml(e, lbMyTs)).join('');
  } catch (e) {
    el.innerHTML = '<div class="lb-empty">榜单加载失败</div>';
  }
}

function setupEndLeaderboard(R) {
  lbSubmitted = false;
  $('#lbSubmit').classList.remove('hidden');
  $('#lbDone').classList.add('hidden');
  $('#lbName').value = localStorage.getItem(LB_NAME_KEY) || '';
  $('#btnSubmitScore').disabled = false;
  $('#btnSubmitScore').textContent = '提交成绩';
  loadEndLeaderboard();
}

async function submitScore(R) {
  if (lbSubmitted) return;
  const btn = $('#btnSubmitScore');
  const name = ($('#lbName').value || '').trim() || '匿名玩家';
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const resp = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, ret: R.ret, bh: R.bh, excess: R.excess, dd: R.dd,
        trades: G.trades.length, rating: R.rating, type: G.q.type, freq: G.freq,
        code: G.q.code, stockName: G.q.name, mode: G.mode || 'free', dailyId: G.dailyId || null,
      }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || '提交失败');
    const data = await resp.json();
    lbSubmitted = true;
    localStorage.setItem(LB_NAME_KEY, name);
    lbMyTs = data.ts || 0;
    $('#lbSubmit').classList.add('hidden');
    const done = $('#lbDone');
    done.classList.remove('hidden');
    done.innerHTML = data.kept === 'best'
      ? `未超过今日最佳成绩，日榜保留你的最佳纪录（当前排名 <b class="pos">第 ${data.rank} 名</b>）`
      : (data.rank <= data.top.length
        ? `已上榜！当前排名 <b class="pos">第 ${data.rank} 名</b>（共 ${data.total} 条记录）`
        : `成绩已记录，排名第 ${data.rank} 名（榜单当前展示前 ${data.top.length} 名）`);
    loadEndLeaderboard();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '提交成绩';
    toast(e.message || '提交失败，请重试');
  }
}

/* ---------------- 排行榜独立界面（总榜 / 每日一题，支持按超额/总收益排序） ---------------- */
let lbBoard = 'total';
let lbSort = 'excess';   // 'excess' 按超额收益（默认）| 'ret' 按总收益
let lbData = null;       // 当前榜单缓存数据
function renderLbList() {
  const el = $('#lbFull');
  if (!lbData || !lbData.length) return;
  const sorted = lbData.slice();
  if (lbSort === 'ret') {
    // 按总收益排序：收益率 → 超额 → 回撤
    sorted.sort((a, b) => (b.ret - a.ret) || (b.excess - a.excess) || (a.dd - b.dd));
  } else {
    // 按超额收益排序：超额 → 收益率 → 回撤（与服务端默认口径一致）
    sorted.sort((a, b) => (b.excess - a.excess) || (b.ret - a.ret) || (a.dd - b.dd));
  }
  sorted.forEach((e, i) => { e.rank = i + 1; });
  el.innerHTML = sorted.map(e => lbCardHtml(e)).join('');
}
function openLbScreen() {
  $('#lbScreen').classList.remove('hidden');
  loadLbBoard();
}
function lbCardHtml(e) {
  const isMe = lbMyTs && e.ts === lbMyTs;
  const rc = e.rank <= 3 ? ' r' + e.rank : '';
  const d = new Date(e.ts);
  const ds = (d.getMonth() + 1) + '-' + d.getDate();
  const stock = e.stockName ? `${e.stockName} ${e.code}` : (e.type === 'stock' ? '个股' : 'ETF');
  return `<div class="lb-card${isMe ? ' me' : ''}">` +
    `<div class="l1"><span class="lb-rank${rc}">${e.rank}</span>` +
    `<span class="lb-name">${e.name}</span>` +
    `<span class="lb-ret ${e.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(e.ret)}</span>` +
    `<span class="lb-rating">${e.rating}</span></div>` +
    `<div class="l2"><span class="lb-stock">${stock}</span><span class="lb-chips">` +
    `<span>基准 <b>${fmtPct(e.bh || 0)}</b></span>` +
    `<span>超额 <b class="${e.excess >= 0 ? 'pos' : 'neg'}">${fmtPct(e.excess)}</b></span>` +
    `<span>回撤 <b>${fmtPct(-e.dd)}</b></span>` +
    `<span>${e.trades}笔·${e.freq === 'd' ? '日K' : '周K'}·${ds}</span>` +
    `</span></div></div>`;
}
async function loadLbBoard() {
  const el = $('#lbFull');
  const hint = $('#lbDailyHint');
  el.innerHTML = '<div class="lb-empty">加载中…</div>';
  if (lbBoard === 'daily') {
    hint.classList.remove('hidden');
    hint.innerHTML = DAILY && DAILY.code
      ? `今日标的：<b>${DAILY.name} ${DAILY.code}</b> · ${DAILY.date.slice(0, 4)}-${DAILY.date.slice(4, 6)}-${DAILY.date.slice(6, 8)}`
      : '每日一题：今日标的';
  } else hint.classList.add('hidden');
  try {
    const url = lbBoard === 'daily' ? '/api/leaderboard?board=daily' : '/api/leaderboard';
    const data = await (await fetch(url)).json();
    if (!data.top || !data.top.length) {
      lbData = null;
      el.innerHTML = '<div class="lb-empty">' +
        (lbBoard === 'daily' ? '今日还没有人上榜，快来抢头名' : '暂无上榜记录') + '</div>';
      return;
    }
    lbData = data.top;
    renderLbList();
  } catch (e) {
    lbData = null;
    el.innerHTML = '<div class="lb-empty">榜单加载失败</div>';
  }
}

/* ---------------- 登录 & 个人中心 ---------------- */
const IN_WX = /micromessenger/i.test(navigator.userAgent);
const AUTH = { loggedIn: false, user: null, wx: { pc: false, mp: false } };
let qrPollTimer = null;

async function refreshAuth() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    AUTH.loggedIn = !!d.loggedIn;
    AUTH.user = d.user || null;
    AUTH.wx = d.wx || { pc: false, mp: false };
  } catch (e) {
    AUTH.loggedIn = false; AUTH.user = null;
  }
  renderAuthBox();
}

function avatarHtml(user, size) {
  if (user && user.avatar) return `<img src="${user.avatar}" alt="">`;
  const ch = (user && user.nickname ? user.nickname : '客')[0];
  return ch;
}

function renderAuthBox() {
  const el = $('#authBox');
  if (!el) return;
  if (AUTH.loggedIn && AUTH.user) {
    el.innerHTML =
      `<div class="auth-user" id="authUserBtn">` +
      `<div class="avatar">${avatarHtml(AUTH.user)}</div>` +
      `<div class="uinfo"><div class="uname">${AUTH.user.nickname}</div>` +
      `<div class="uid">ID: ${AUTH.user.openidMasked}</div></div>` +
      `<span class="ugo">个人中心 ›</span></div>`;
    $('#authUserBtn').onclick = openUserCenter;
  } else {
    const label = IN_WX ? '微信一键登录' : '微信扫码登录';
    el.innerHTML =
      `<button class="btn btn-accent auth-login-btn" id="btnLogin">${label}</button>` +
      `<div class="auth-hint">登录后可上榜、保存战绩、多设备同步</div>`;
    $('#btnLogin').onclick = openLogin;
  }
}

function openLogin() {
  if (IN_WX && AUTH.wx.mp) {
    // 微信内 + 已配置公众号：直接跳转网页授权
    location.href = '/api/auth/login?env=wx';
    return;
  }
  if (!IN_WX && AUTH.wx.pc) {
    // PC + 已配置开放平台：扫码弹窗（官方 QRConnect 页面）
    showQrModal('loading');
    fetch('/api/auth/login?env=pc&json=1')
      .then(r => r.json())
      .then(d => {
        if (d.url) {
          $('#qrBox').innerHTML = `<iframe src="${d.url}"></iframe>`;
          startQrPolling();
        } else showQrMock();
      })
      .catch(showQrMock);
    return;
  }
  // 未配置微信资质：演示模式
  showQrModal('mock');
}

function showQrModal(mode) {
  $('#qrModal').classList.remove('hidden');
  const btn = $('#qrModal #btnQrClose');
  btn.textContent = '取消';
  btn.className = 'btn btn-secondary';
  btn.onclick = closeQrModal;
  $('#qrModal .qr-tip').textContent = '使用微信扫码，授权后自动登录';
  if (mode === 'loading') $('#qrBox').innerHTML = '<div class="qr-mock">二维码加载中…</div>';
  else if (mode === 'mock') showQrMock();
}

function showQrMock() {
  $('#qrBox').innerHTML =
    `<div class="qr-mock">微信登录尚未配置<br>（需要开放平台/公众号资质 + 备案域名）<br>当前为演示模式：` +
    `<input id="mockName" maxlength="12" placeholder="输入昵称，模拟微信登录"></div>`;
  $('#qrModal .qr-tip').textContent = '演示模式仅用于功能测试，正式上线后自动切换为微信扫码';
  const btn = $('#qrModal #btnQrClose');
  btn.textContent = '模拟登录';
  btn.className = 'btn btn-accent';
  btn.style.width = '100%';
  btn.onclick = mockLogin;
}

async function mockLogin() {
  const name = ($('#mockName') && $('#mockName').value.trim()) || '演示用户';
  const btn = $('#qrModal #btnQrClose');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/mock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '登录失败');
    closeQrModal();
    await refreshAuth();
    toast('已登录：' + d.user.nickname);
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
}

function startQrPolling() {
  stopQrPolling();
  qrPollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/me');
      const d = await r.json();
      if (d.loggedIn) {
        closeQrModal();
        await refreshAuth();
        toast('登录成功');
      }
    } catch (e) {}
  }, 2500);
}
function stopQrPolling() {
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
}
function closeQrModal() {
  stopQrPolling();
  $('#qrModal').classList.add('hidden');
}

/* 个人中心 */
async function openUserCenter() {
  if (!AUTH.loggedIn) return;
  const u = AUTH.user;
  $('#ucAvatar').innerHTML = avatarHtml(u);
  $('#ucName').textContent = u.nickname;
  $('#ucId').textContent = 'ID: ' + u.openidMasked;
  $('#ucNameInput').value = u.nickname;
  $('#ucStats').innerHTML = '';
  $('#ucRecords').innerHTML = '<div class="lb-empty">加载中…</div>';
  $('#userScreen').classList.remove('hidden');
  try {
    const r = await fetch('/api/me/records');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '加载失败');
    renderUserStats(d.summary);
    renderUserRecords(d.records);
  } catch (e) {
    $('#ucRecords').innerHTML = '<div class="lb-empty">战绩加载失败</div>';
  }
}

function renderUserStats(s) {
  const cells = [
    ['对局数', s.games],
    ['最佳收益', s.bestRet == null ? '—' : fmtPct(s.bestRet)],
    ['平均收益', s.avgRet == null ? '—' : fmtPct(s.avgRet)],
    ['最佳评级', s.bestRating || '—'],
  ];
  $('#ucStats').innerHTML = cells.map(c =>
    `<div class="cell"><span>${c[0]}</span><b>${c[1]}</b></div>`).join('');
}

function renderUserRecords(rs) {
  const el = $('#ucRecords');
  if (!rs || !rs.length) {
    el.innerHTML = '<div class="lb-empty">暂无战绩，去玩一局吧</div>';
    return;
  }
  el.innerHTML = rs.map(r => {
    const d = new Date(r.ts);
    const ds = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<div class="lb-row">` +
      `<span class="lb-date">${ds}</span>` +
      `<span class="lb-name">${r.type === 'stock' ? '个股' : 'ETF'} · ${r.freq === 'd' ? '日K' : '周K'} · ${r.trades}笔</span>` +
      `<span class="lb-ret ${r.ret >= 0 ? 'pos' : 'neg'}">${fmtPct(r.ret)}</span>` +
      `<span class="lb-rating">${r.rating}</span></div>`;
  }).join('');
}

async function saveNickname() {
  const v = $('#ucNameInput').value.trim();
  if (!v) { toast('昵称不能为空'); return; }
  const btn = $('#btnSaveName');
  btn.disabled = true;
  try {
    const r = await fetch('/api/me/nickname', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: v }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '保存失败');
    AUTH.user.nickname = d.nickname;
    $('#ucName').textContent = d.nickname;
    localStorage.setItem(LB_NAME_KEY, d.nickname);
    renderAuthBox();
    toast('昵称已更新');
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  $('#userScreen').classList.add('hidden');
  await refreshAuth();
  toast('已退出登录');
}

/* ---------------- 提示 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
}

/* ---------------- 事件绑定 ---------------- */
// 主题切换
function applyTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem('klt_theme', name);
  $('#themeToggle').textContent = name === 'dark' ? '🌙' : '☀️';
  if (G && !$('#gameScreen').classList.contains('hidden')) { renderChart(); renderTrades(); }
  if (G && G.over && !$('#endScreen').classList.contains('hidden')) renderReportCharts();
}
(function loadTheme() {
  const saved = localStorage.getItem('klt_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
})();
$('#themeToggle').onclick = () => applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');

// 标的显示切换
$$('.toggle-group button').forEach(btn => {
  btn.onclick = () => {
    $$('.toggle-group button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
  };
});

$('#btnStart').onclick = startGame;
$('#btnAgain').onclick = startGame;
$('#btnHome').onclick = () => {
  $('#endScreen').classList.add('hidden');
  $('#gameScreen').classList.add('hidden');
  $('#startScreen').classList.remove('hidden');
  refreshDaily();
};
$('#btnA').onclick = () => act('buy');
$('#btnB').onclick = () => act('sell');
$('#btnC').onclick = () => act('hold');
$('#posPct').oninput = () => { updateControls(); };
$('#btnFreq').onclick = toggleFreq;
$('#btnAI').onclick = requestAIAnalysis;
$('#btnSubmitScore').onclick = () => { if (lastR) submitScore(lastR); };
$('#btnUcClose').onclick = () => $('#userScreen').classList.add('hidden');
$('#btnLogout').onclick = logout;
$('#btnSaveName').onclick = saveNickname;
$('#btnLb').onclick = openLbScreen;
$('#btnLbClose').onclick = () => $('#lbScreen').classList.add('hidden');
$('#btnRec').onclick = openRecScreen;
$('#btnRecClose').onclick = () => $('#recScreen').classList.add('hidden');
$$('.lb-tab').forEach(t => {
  t.onclick = () => {
    $$('.lb-tab').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    lbBoard = t.dataset.board;
    loadLbBoard();
  };
});
$$('.lb-sort').forEach(t => {
  t.onclick = () => {
    $$('.lb-sort').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    lbSort = t.dataset.sort;
    renderLbList();
  };
});
$('#btnHelp').onclick = () => $('#helpScreen').classList.remove('hidden');
// 问号提示：移动端无 hover，点击时 toast 显示说明
$$('.info-btn').forEach(el => {
  el.addEventListener('click', e => { e.stopPropagation(); toast(el.dataset.tip || ''); });
});
$('#btnHelpClose').onclick = () => $('#helpScreen').classList.add('hidden');
$('#btnDaily').onclick = startDaily;

// 移动端交易记录抽屉
$('#btnTrades').onclick = () => $('#tradeDrawer').classList.add('open');
$('#btnCloseDrawer').onclick = () => $('#tradeDrawer').classList.remove('open');

// 指标开关
$$('.toolbar-btn[data-ind]').forEach(btn => {
  btn.onclick = () => {
    if (!G) return;
    const ind = btn.dataset.ind;
    G.indicators[ind] = !G.indicators[ind];
    btn.classList.toggle('on', G.indicators[ind]);
    renderChart();
  };
});

// 滚轮缩放
$('#chartWrap').addEventListener('wheel', (e) => {
  e.preventDefault();
  handleZoom(e.deltaY);
}, { passive: false });

const chartEl = $('#chart');
chartEl.addEventListener('mousemove', e => {
  if (!G || G.over) return;
  const r = chartEl.getBoundingClientRect();
  G.cross = { x: e.clientX - r.left, y: e.clientY - r.top, mx: e.clientX - r.left, my: e.clientY - r.top };
  renderChart();
});
chartEl.addEventListener('mouseleave', () => {
  if (!G) return;
  G.cross = null;
  $('#tip').classList.remove('show');
  renderChart();
});

// 触摸支持
let touchStartX = 0;
chartEl.addEventListener('touchstart', e => {
  if (!G || G.over) return;
  touchStartX = e.touches[0].clientX;
  const t = e.touches[0], r = chartEl.getBoundingClientRect();
  G.cross = { x: t.clientX - r.left, y: t.clientY - r.top, mx: t.clientX - r.left, my: t.clientY - r.top };
  renderChart();
}, { passive: true });

chartEl.addEventListener('touchmove', e => {
  if (!G || G.over) return;
  e.preventDefault();
  const t = e.touches[0], r = chartEl.getBoundingClientRect();
  touchStartX = t.clientX;
  G.cross = { x: t.clientX - r.left, y: t.clientY - r.top, mx: t.clientX - r.left, my: t.clientY - r.top };
  renderChart();
}, { passive: false });

chartEl.addEventListener('touchend', () => {
  if (!G) return;
  G.cross = null;
  $('#tip').classList.remove('show');
  renderChart();
});

window.addEventListener('resize', () => {
  if (G && !$('#gameScreen').classList.contains('hidden')) { renderChart(); renderHUD(); }
});

document.addEventListener('keydown', e => {
  if (!G || G.over) return;
  if ($('#gameScreen').classList.contains('hidden') ||
      !$('#endScreen').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (k === 'b') act('buy');
  else if (k === 's') act('sell');
  else if (k === ' ' || k === 'n' || k === 'enter') { e.preventDefault(); act('hold'); }
});

// 登录回调错误提示
(function checkLoginErr() {
  const m = /[?&]login_err=([^&]+)/.exec(location.search);
  if (m) {
    toast('登录失败：' + decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname);
  }
})();

/* ---------------- 初始化：每日一题 + 题库预载 + 启用开始按钮 ---------------- */
async function initApp() {
  const btn = $('#btnStart');
  const track = $('#loadTrack');
  const fill = $('#loadFill');
  if (fill) fill.style.width = '15%';
  // 并行拉取：每日一题 / 登录状态 / 榜单预览
  try { DAILY = await (await fetch('/api/daily')).json(); } catch (e) { DAILY = null; }
  renderDailyCard();
  refreshAuth();
  await initBank(DAILY && DAILY.code, p => { if (fill) fill.style.width = (15 + p * 85) + '%'; });
  setTimeout(() => { if (track) track.style.display = 'none'; }, 400);
  if (window.QBANK && QBANK.length) {
    btn.disabled = false;
    btn.textContent = '开始挑战';
  } else {
    btn.textContent = '题库加载失败，请刷新页面';
  }
}
initApp();
