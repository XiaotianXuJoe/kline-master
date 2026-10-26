'use strict';
/**
 * K线之王 - 全栈服务（Node 原生实现，零依赖）
 * 1. 静态文件服务（index.html / app.js / data/*.js）
 * 2. POST /api/analyze — AI 交易分析（内置 Kimi k2.6 非思考模式，不暴露给前端）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const PORT = parseInt(process.env.PORT || '3000', 10);
const ANALYZE_RL = new Map(); // IP -> [timestamps]，AI 分析接口限频

// 密钥从环境变量读取，切勿硬编码进可被静态服务下载的文件
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const MODEL = 'kimi-k2.6';
// kimi-k2.6 非思考模式：thinking={"type":"disabled"}，此时 temperature 固定为 0.6

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

// 静态资源白名单：仅放行前端需要的文件，杜绝源码/密钥/用户数据被下载
function isStaticAllowed(p) {
  if (p === '/' || p === '/index.html' || p === '/app.js' || p === '/favicon.ico') return true;
  if (process.env.KLT_TEST === '1' && /^\/_test[0-9]*\.html$/.test(p)) return true; // 本地测试钩子
  // data/ 目录下仅允许 .js 数据文件（manifest.js、q*.js）
  if (/^\/data\/[A-Za-z0-9_-]+\.js$/.test(p)) return true;
  return false;
}

function serveStatic(req, res) {
  let p;
  try {
    p = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 bad request');
    return;
  }
  if (!isStaticAllowed(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
    return;
  }
  if (p === '/') p = '/index.html';
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const fp = path.join(BASE_DIR, safe);
  if (!fp.startsWith(BASE_DIR) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  const content = fs.readFileSync(fp);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

function buildPrompt(data) {
  const trades = data.trades || [];
  const stats = data.stats || {};
  let tradeText = '';
  trades.forEach((t, i) => {
    const action = t.type === 'buy' ? '买入' : '卖出';
    tradeText += `${i + 1}. ${t.label} ${action} ${t.shares || '?'}股 @ ${Number(t.price).toFixed(2)}`;
    if (t.pnlPct != null) tradeText += ` (盈亏: ${(t.pnlPct * 100).toFixed(2)}%)`;
    tradeText += '\n';
  });
  const pct = x => (Number(x) * 100).toFixed(2) + '%';

  // 计算额外统计指标
  const sells = trades.filter(t => t.type === 'sell');
  const wins = sells.filter(t => t.pnl > 0);
  const winRate = sells.length ? (wins.length / sells.length * 100).toFixed(0) : '—';
  const avgWin = wins.length ? (wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length * 100).toFixed(2) : '0.00';
  const losses = sells.filter(t => t.pnl < 0);
  const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length * 100).toFixed(2) : '0.00';
  const profitFactor = (losses.length && avgLoss !== '0.00') ? (Math.abs(avgWin / avgLoss)).toFixed(2) : '—';

  // 挑战区间行情（仅 start→end 跨度，格式：日期,开,高,低,收）
  let klineText = '';
  const kl = Array.isArray(data.kline) ? data.kline.slice(0, 200) : [];
  if (kl.length) {
    klineText = '\n### 挑战区间行情（' + (stats.startDate || '') + ' ~ ' + (stats.endDate || '') +
      '，共 ' + kl.length + ' 根K线，格式：日期,开,高,低,收）\n' +
      kl.map(k => k.join(',')).join('\n') + '\n';
  }

  return `你是一位资深量化交易教练，正在点评一位学员在「单一标的 K 线盘感训练器」中的一局模拟交易。

### 训练器规则（分析必须在此框架内进行）
- 只有**一只标的**，玩家只有三种操作：买入、卖出、观望（跳过一根K线）
- 仓位通过滑条控制（10%~100%，步长 10%）：买入 = 当前现金的百分比，卖出 = 当前持仓的百分比，均为 100 股整手
- T+1 规则（当日买入部分次日才能卖出），含佣金、印花税、滑点
- 初始资金 100 万虚拟本金

### 挑战区间
本次分析**只允许**基于挑战区间（${stats.startDate || '未知'} ~ ${stats.endDate || '未知'}，约 ${stats.days || '?'} 个交易日，${stats.freq === 'w' ? '周K' : '日K'}）内的行情与交易行为。
**禁止**推测或讨论该区间之前的走势，也**禁止**给出配置其他资产、分散投资、跨品种对冲等建议——训练器只能交易这一只标的。

### 基础数据
| 指标 | 数值 |
|------|------|
| 总收益率 | ${pct(stats.ret || 0)} |
| 买入持有基准 | ${pct(stats.bh || 0)} |
| 超额收益 | ${pct(stats.excess || 0)} |
| 最大回撤 | ${pct(stats.dd || 0)} |
| 交易次数 | ${stats.trades || 0} |
| 胜率 | ${winRate}% |
| 平均盈利 | ${avgWin}% |
| 平均亏损 | ${avgLoss}% |
| 盈亏比 | ${profitFactor} |

### 交易明细
${tradeText || '（无交易）'}
${klineText}
### 分析要求
结合上述挑战区间的实际行情结构（趋势/震荡/关键高低点），从以下 **8 个维度** 逐条输出，每条用 1-3 句话，专业犀利、直击要害，点评必须落到区间内的具体日期和价格：

1. **择时能力** — 买卖点相对区间高低点的质量，是否买在恐慌/卖在贪婪
2. **风险控制** — 最大回撤发生在区间哪一段、单笔亏损控制、止损纪律
3. **盈亏比与胜率** — 赔率是否合理，是否存在"赚小钱亏大钱"
4. **仓位管理** — 仓位滑条使用是否合理：趋势确立时是否敢于加仓、信号不明时是否降仓试探、是否长期 100% 满仓硬扛回撤；**仅评价单标的仓位比例与加减仓节奏，不得建议配置其他资产**
5. **交易频率与纪律** — 是否频繁交易、有无冲动操作
6. **持股周期** — 平均持仓天数，是否过早止盈或过晚止损
7. **心理与情绪** — 是否存在追涨杀跌、FOMO、恐慌割肉等行为痕迹
8. **改进建议** — 2-3 条在本训练器框架内可执行的方案（择时、仓位比例、持/观节奏）

### 格式要求
- 使用 Markdown 标准语法（## 标题、**加粗**、- 列表、> 引用块）
- 开头用一段 50 字内的 **总评**，放在引用块里
- 总字数 300-500 字
- 语气像资深交易员对学员的点评，不客套、不捧杀`;
}

/* ---------------- 排行榜（JSON 文件持久化） ---------------- */
const LB_FILE = path.join(BASE_DIR, 'leaderboard.json');
const LB_MAX = 200;      // 最多保留条数
const LB_TOP = 50;       // 查询返回条数
const VALID_RATINGS = new Set(['S', 'A', 'B', 'C', 'D']);

function loadLB() {
  try {
    const arr = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveLB(list) {
  try {
    fs.writeFileSync(LB_FILE, JSON.stringify(list.slice(0, LB_MAX)));
  } catch (e) { console.error('排行榜写入失败:', e.message); }
}
function sortLB(list) {
  // 排序：超额收益优先，其次收益率，回撤小者优先
  return list.sort((a, b) =>
    (b.excess - a.excess) || (b.ret - a.ret) || (a.dd - b.dd) || (a.ts - b.ts));
}
function publicEntry(e, rank) {
  return { rank: rank + 1, name: e.name, ret: e.ret, bh: e.bh, excess: e.excess, dd: e.dd,
           trades: e.trades, rating: e.rating, type: e.type, freq: e.freq, ts: e.ts,
           code: e.code || '', stockName: e.stockName || '',
           mode: e.mode || 'free', dailyId: e.dailyId || null };
}
function handleScoreSubmit(req, res, body) {
  let d;
  try { d = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  // 登录用户：以 openid 为唯一身份，昵称取自账号（忽略前端传入的 name）
  const su = sessionUser(req);
  let openid = null, name;
  if (su) { openid = su.openid; name = su.user.nickname; }
  else name = cleanName(d.name);

  // 校验数值（范围宽松校验，防明显作弊/脏数据）
  const num = (v, lo, hi) => {
    const x = Number(v);
    return (Number.isFinite(x) && x >= lo && x <= hi) ? x : null;
  };
  const ret = num(d.ret, -1, 20), bh = num(d.bh, -1, 20), excess = num(d.excess, -20, 40),
        dd = num(d.dd, 0, 1), trades = num(d.trades, 0, 10000);
  if ([ret, bh, excess, dd, trades].some(v => v === null))
    return sendJson(res, 400, { error: '成绩数据不合法' });

  const rating = VALID_RATINGS.has(d.rating) ? d.rating : 'D';
  const type = d.type === 'etf' ? 'etf' : 'stock';
  const freq = d.freq === 'w' ? 'w' : 'd';

  // 标的与模式（每日一题需服务端复核：日期与标的一致才计入日榜）
  const code = /^[0-9A-Za-z]{4,8}$/.test(String(d.code || '')) ? String(d.code) : '';
  const stockName = cleanName(d.stockName).slice(0, 12);
  let mode = 'free', dailyId = null;
  // 每日一题：服务端复核日期与标的，且必须登录（匿名成绩不计入日榜，防伪造刷榜）
  if (d.mode === 'daily' && /^[0-9]{8}$/.test(String(d.dailyId || '')) && freq === 'd' && su) {
    const pick = dailyPick(todayCN());
    if (pick && d.dailyId === pick.date && code === pick.code) {
      mode = 'daily'; dailyId = pick.date;
    }
  }

  const list = loadLB();
  const entry = { name, ret, bh, excess, dd, trades: Math.round(trades), rating, type, freq,
                  code, stockName, mode, dailyId, ts: Date.now() };
  if (openid) entry.openid = openid;

  // 同一用户同一每日一题只保留最佳成绩（防重复刷榜）
  if (mode === 'daily' && openid) {
    const cmp = (a, b) => (b.excess - a.excess) || (b.ret - a.ret) || (a.dd - b.dd);
    const idx = list.findIndex(e => e.mode === 'daily' && e.dailyId === dailyId && e.openid === openid);
    if (idx >= 0) {
      if (cmp(entry, list[idx]) >= 0) {
        // 新成绩不优于历史最佳：榜单保持不变，返回既有名次
        sortLB(list);
        const rank0 = list.indexOf(list[idx]) + 1;
        return sendJson(res, 200, { ok: true, rank: rank0, total: list.length, ts: list[idx].ts,
                                    kept: 'best', entry: publicEntry(list[idx], rank0 - 1) });
      }
      list.splice(idx, 1);
    }
  }
  list.push(entry);
  sortLB(list);
  saveLB(list);

  // 登录用户：写入个人战绩
  if (openid) {
    const recs = loadJson(RECORDS_FILE, []);
    recs.unshift({ openid, ret, bh, excess, dd, trades: entry.trades, rating, type, freq, ts: entry.ts });
    saveJson(RECORDS_FILE, recs.slice(0, 5000));
  }

  const ranked = resolveNames(list);
  const rank = list.indexOf(entry) + 1;
  sendJson(res, 200, { ok: true, rank, total: list.length, ts: entry.ts,
                       top: ranked.slice(0, LB_TOP).map(publicEntry) });
}
/* GET /api/leaderboard?board=total|daily&date=YYYYMMDD */
function handleLeaderboard(req, res, params) {
  let list = sortLB(loadLB());
  const board = params.get('board') || 'total';
  if (board === 'daily') {
    const date = /^[0-9]{8}$/.test(params.get('date') || '') ? params.get('date') : todayCN();
    list = list.filter(e => e.dailyId === date);
  }
  list = resolveNames(list);
  sendJson(res, 200, { board, top: list.slice(0, LB_TOP).map(publicEntry), total: list.length });
}

/* ---------------- 用户体系 & 微信登录框架 ---------------- */
const crypto = require('crypto');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const SESSIONS_FILE = path.join(BASE_DIR, 'sessions.json');
const RECORDS_FILE = path.join(BASE_DIR, 'records.json');
const WX_CONF_FILE = path.join(BASE_DIR, 'wx-config.json');
const SESSION_TTL = 30 * 86400 * 1000;   // 会话 30 天
const pendingStates = new Map();          // OAuth state -> { env, ts }

function loadJson(f, dft) {
  try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v == null ? dft : v; }
  catch (e) { return dft; }
}
function saveJson(f, v) {
  try { fs.writeFileSync(f, JSON.stringify(v)); }
  catch (e) { console.error('写入失败', f, e.message); }
}

/* 微信配置（wx-config.json，缺省为空 = 未配置，走演示模式）
 * {
 *   "openAppId": "", "openAppSecret": "",   // 开放平台-网站应用（PC 扫码）
 *   "mpAppId": "",   "mpAppSecret": "",     // 公众号-服务号（微信内授权）
 *   "callbackDomain": "https://your.domain" // 已备案回调域名（不带路径）
 * } */
function wxConf() {
  const c = loadJson(WX_CONF_FILE, {});
  return {
    openAppId: c.openAppId || '', openAppSecret: c.openAppSecret || '',
    mpAppId: c.mpAppId || '', mpAppSecret: c.mpAppSecret || '',
    callbackDomain: (c.callbackDomain || '').replace(/\/+$/, ''),
  };
}

function getUsers() { return loadJson(USERS_FILE, {}); }
function getSessions() {
  const s = loadJson(SESSIONS_FILE, {});
  const now = Date.now();
  let dirty = false;
  for (const k of Object.keys(s)) {
    if (!s[k] || now - s[k].ts > SESSION_TTL) { delete s[k]; dirty = true; }
  }
  if (dirty) saveJson(SESSIONS_FILE, s);
  return s;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)klt_sid=([0-9a-f]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = getSessions()[m[1]];
  if (!s) return null;
  const u = getUsers()[s.openid];
  return u ? { openid: s.openid, user: u } : null;
}
function createSession(res, openid) {
  const sid = crypto.randomBytes(24).toString('hex');
  const ss = getSessions();
  ss[sid] = { openid, ts: Date.now() };
  saveJson(SESSIONS_FILE, ss);
  res.setHeader('Set-Cookie',
    `klt_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
}
function cleanName(v) {
  const name = String(v == null ? '' : v)
    .replace(/<[^>]*>?/g, '')              // 去标签
    .replace(/[^\w一-龥·\-_ ]/g, '')      // 白名单：字母数字/中文/·-_
    .trim().slice(0, 12);
  return name || '匿名玩家';
}
function maskOpenid(id) {
  return id.length > 8 ? id.slice(0, 4) + '****' + id.slice(-4) : id;
}

function wxGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('微信接口响应解析失败')); }
      });
    }).on('error', reject);
  });
}

/* GET /api/auth/login?env=pc|wx[&json=1] */
function handleWxLogin(req, res, env) {
  const c = wxConf();
  const isPc = env !== 'wx';
  const appId = isPc ? c.openAppId : c.mpAppId;
  if (!appId || !c.callbackDomain)
    return sendJson(res, 503, { error: '微信登录未配置', mock: true });
  const state = crypto.randomBytes(8).toString('hex');
  pendingStates.set(state, { env: isPc ? 'pc' : 'wx', ts: Date.now() });
  // 清理过期 state（10 分钟）
  for (const [k, v] of pendingStates) if (Date.now() - v.ts > 600000) pendingStates.delete(k);
  const redirect = encodeURIComponent(c.callbackDomain + '/api/auth/callback?env=' + (isPc ? 'pc' : 'wx'));
  const url = isPc
    ? `https://open.weixin.qq.com/connect/qrconnect?appid=${appId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`
    : `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_userinfo&state=${state}#wechat_redirect`;
  if (req.url.includes('json=1')) return sendJson(res, 200, { url });
  res.writeHead(302, { Location: url });
  res.end();
}

/* GET /api/auth/callback?code=&state=&env= */
async function handleWxCallback(req, res, q) {
  const fail = msg => {
    res.writeHead(302, { Location: '/?login_err=' + encodeURIComponent(msg) });
    res.end();
  };
  const st = pendingStates.get(q.state);
  pendingStates.delete(q.state);
  if (!q.code || !st) return fail('登录状态无效或已过期');
  const c = wxConf();
  const isPc = st.env === 'pc';
  const appId = isPc ? c.openAppId : c.mpAppId;
  const secret = isPc ? c.openAppSecret : c.mpAppSecret;
  if (!appId || !secret) return fail('微信登录未配置');
  try {
    const tok = await wxGetJson(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${secret}&code=${q.code}&grant_type=authorization_code`);
    if (!tok.openid) return fail('微信授权失败: ' + (tok.errmsg || '未知错误'));
    let nickname = '微信用户', avatar = '';
    try {
      const info = await wxGetJson(
        `https://api.weixin.qq.com/sns/userinfo?access_token=${tok.access_token}&openid=${tok.openid}&lang=zh_CN`);
      if (info.nickname) nickname = cleanName(info.nickname);
      if (info.headimgurl) avatar = String(info.headimgurl);
    } catch (e) { /* snsapi_base 或无权限时忽略 */ }
    const users = getUsers();
    if (!users[tok.openid]) {
      users[tok.openid] = { nickname, avatar, createdAt: Date.now() };
    } else if (!users[tok.openid].nicknameEdited) {
      users[tok.openid].nickname = nickname;
      if (avatar) users[tok.openid].avatar = avatar;
    }
    saveJson(USERS_FILE, users);
    createSession(res, tok.openid);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (e) {
    fail('微信登录异常，请重试');
  }
}

/* POST /api/auth/mock { name } — 演示模式：仅在未配置微信时可用 */
function handleMockLogin(req, res, body) {
  const c = wxConf();
  if ((c.openAppId && c.openAppSecret) || (c.mpAppId && c.mpAppSecret))
    return sendJson(res, 403, { error: '已配置真实微信登录，演示模式已关闭' });
  let d = {};
  try { d = JSON.parse(body || '{}'); } catch (e) {}
  const name = cleanName(d.name || '演示用户');
  const openid = 'mock_' + crypto.createHash('md5').update(name).digest('hex').slice(0, 12);
  const users = getUsers();
  if (!users[openid]) users[openid] = { nickname: name, avatar: '', createdAt: Date.now(), mock: true };
  saveJson(USERS_FILE, users);
  createSession(res, openid);
  sendJson(res, 200, { ok: true, user: { nickname: users[openid].nickname, openidMasked: maskOpenid(openid) } });
}

/* POST /api/auth/logout */
function handleLogout(req, res) {
  const m = /(?:^|;\s*)klt_sid=([0-9a-f]+)/.exec(req.headers.cookie || '');
  if (m) {
    const ss = getSessions();
    delete ss[m[1]];
    saveJson(SESSIONS_FILE, ss);
  }
  res.setHeader('Set-Cookie', 'klt_sid=; Path=/; HttpOnly; Max-Age=0');
  sendJson(res, 200, { ok: true });
}

/* GET /api/me — 登录状态 + 用户信息 + 微信配置状态 */
function handleMe(req, res) {
  const c = wxConf();
  const su = sessionUser(req);
  sendJson(res, 200, {
    loggedIn: !!su,
    user: su ? {
      nickname: su.user.nickname,
      avatar: su.user.avatar || '',
      openidMasked: maskOpenid(su.openid),
      createdAt: su.user.createdAt || 0,
    } : null,
    wx: {
      pc: !!(c.openAppId && c.openAppSecret && c.callbackDomain),
      mp: !!(c.mpAppId && c.mpAppSecret && c.callbackDomain),
    },
  });
}

/* POST /api/me/nickname { nickname } */
function handleNickname(req, res, body) {
  const su = sessionUser(req);
  if (!su) return sendJson(res, 401, { error: '未登录' });
  let d = {};
  try { d = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: '格式错误' }); }
  const name = cleanName(d.nickname);
  const users = getUsers();
  users[su.openid].nickname = name;
  users[su.openid].nicknameEdited = true;
  users[su.openid].updatedAt = Date.now();
  saveJson(USERS_FILE, users);
  sendJson(res, 200, { ok: true, nickname: name });
}

/* GET /api/me/records — 个人战绩（最多 50 条）+ 汇总 */
function handleMyRecords(req, res) {
  const su = sessionUser(req);
  if (!su) return sendJson(res, 401, { error: '未登录' });
  const all = loadJson(RECORDS_FILE, []);
  const mine = all.filter(r => r.openid === su.openid).slice(0, 50);
  const n = mine.length;
  const summary = {
    games: n,
    bestRet: n ? Math.max.apply(null, mine.map(r => r.ret)) : null,
    avgRet: n ? mine.reduce((s, r) => s + r.ret, 0) / n : null,
    bestRating: n ? mine.map(r => r.rating).sort((a, b) =>
      ({ S: 0, A: 1, B: 2, C: 3, D: 4 }[a] ?? 9) - ({ S: 0, A: 1, B: 2, C: 3, D: 4 }[b] ?? 9))[0] : null,
  };
  sendJson(res, 200, { records: mine, summary });
}

/* 排行榜条目按 openid 解析最新昵称（改名后榜单同步） */
function resolveNames(list) {
  const users = getUsers();
  return list.map(e =>
    (e.openid && users[e.openid]) ? Object.assign({}, e, { name: users[e.openid].nickname }) : e);
}

/* ---------------- 每日一题 ---------------- */
function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}
function dailyPick(dateStr) {
  const mf = loadJson(path.join(BASE_DIR, 'data', 'manifest.json'), []);
  if (!mf.length) return null;
  let h = 0;
  for (const ch of dateStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const q = mf[h % mf.length];
  return { date: dateStr, code: q.code, name: q.name, type: q.type };
}

/* GET /api/daily — 今日挑战标的（含当前用户今日最佳成绩） */
function handleDaily(req, res) {
  const pick = dailyPick(todayCN());
  if (!pick) return sendJson(res, 503, { error: '题库名录未就绪' });
  const out = { date: pick.date, code: pick.code, name: pick.name, type: pick.type };
  const su = sessionUser(req);
  if (su) {
    const mine = loadLB().filter(e => e.dailyId === pick.date && e.openid === su.openid);
    if (mine.length) {
      const best = mine.reduce((a, b) => (b.excess > a.excess ? b : a));
      out.myBest = { ret: best.ret, excess: best.excess, rating: best.rating, plays: mine.length };
    } else out.myBest = null;
  }
  sendJson(res, 200, out);
}

function callKimi(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      thinking: { type: 'disabled' },  // 非思考模式（temperature 固定 0.6）
      messages: [
        { role: 'system', content: '你是一位专业的股票交易教练，擅长分析交易记录并给出建设性意见。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
    });
    const req = https.request(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve(json.choices[0].message.content || '');
          } else {
            reject(new Error(json.error ? json.error.message : 'Kimi API 返回异常'));
          }
        } catch (e) {
          reject(new Error('Kimi API 响应解析失败'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Kimi API 请求超时')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  if (req.method === 'GET' && pathname === '/api/auth/login')
    return handleWxLogin(req, res, u.searchParams.get('env'));
  if (req.method === 'GET' && pathname === '/api/auth/callback')
    return handleWxCallback(req, res, Object.fromEntries(u.searchParams));
  if (req.method === 'POST' && pathname === '/api/auth/mock') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => handleMockLogin(req, res, body));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout')
    return handleLogout(req, res);
  if (req.method === 'GET' && pathname === '/api/me')
    return handleMe(req, res);
  if (req.method === 'POST' && pathname === '/api/me/nickname') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => handleNickname(req, res, body));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/me/records')
    return handleMyRecords(req, res);

  if (req.method === 'POST' && req.url === '/api/score') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => handleScoreSubmit(req, res, body));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    handleLeaderboard(req, res, u.searchParams);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/daily')
    return handleDaily(req, res);
  if (req.method === 'POST' && req.url === '/api/analyze') {
    // 付费 API 防刷：按 IP 限频（每小时 10 次），trades 截断，密钥缺失时优雅降级
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const rl = ANALYZE_RL.get(ip) || [];
    const recent = rl.filter(t => now - t < 3600e3);
    if (recent.length >= 10) return sendJson(res, 429, { error: 'AI 分析请求过于频繁，请稍后再试' });
    if (!KIMI_API_KEY) return sendJson(res, 503, { error: 'AI 分析服务暂未配置' });
    recent.push(now); ANALYZE_RL.set(ip, recent);
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.trades) && data.trades.length > 100)
          data.trades = data.trades.slice(0, 100);
        const analysis = await callKimi(buildPrompt(data));
        sendJson(res, 200, { analysis });
      } catch (e) {
        sendJson(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`K线之王服务运行在 http://0.0.0.0:${PORT}`);
});
