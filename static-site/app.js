/* 股票投研看板 · 开源静态演示版 前端逻辑
数据全部来自本地静态 JSON（由 export_static.py 从数据库导出）：
  ./data-static/portfolio.json    首屏快照（自选股 / 推荐股 / 板块）
  ./data-static/stocks.json      全市场搜索列表（5527 只）
  ./data-static/sectors.json     板块指数表现
  ./data-static/stocks/<code>.json  预生成个股详情（自选+热门龙头）
  ./data-static/sectors/<name>.json 板块下钻成分股
实时行情：浏览器直连腾讯财经接口（CORS=*），无需后端。
四页：市场看板 / 个股详情 / AI 问答（端侧规则+数据）/ 组合诊断。
*/
const STATIC_BASE = './data-static';
const $ = (id) => document.getElementById(id);
const UP = '#e23c35', DOWN = '#1aa260';     // A股 红涨绿跌
const fmt = (v, d = 2) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
const fmtBig = (v) => {
  if (v == null) return '—';
  if (v >= 10000) return (v / 10000).toFixed(2) + ' 万亿';
  if (v >= 1) return v.toFixed(0) + ' 亿';
  return v.toFixed(0) + ' 万';
};
const colorOf = (v) => (v == null) ? 'var(--text-faint)' : (v >= 0 ? UP : DOWN);
const sign = (v) => (v == null ? '' : (v >= 0 ? '+' : ''));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const firstUpper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// 主题感知的图表配色（科技蓝）
function themeColors() {
  const dark = document.body.classList.contains('dark');
  return {
    text: dark ? '#9aa3ba' : '#6b7488',
    axis: dark ? '#3a4360' : '#e6e9f0',
    split: dark ? 'rgba(255,255,255,.06)' : '#eef1f7',
    up: dark ? '#ff5a52' : '#e23c35',
    down: dark ? '#25c281' : '#1aa260',
    accent: dark ? '#3b82f6' : '#2563eb',
    accent2: dark ? '#22d3ee' : '#0ea5e9',
  };
}

let PORT = null;
let charts = {};
let currentDetail = null;
let currentSectors = null;
let ALL_STOCKS = null;
let POOL = null;
let currentView = 'market';

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ===== 实时行情（客户端直连腾讯财经，无需后端） ===== */
const LIVE_API = 'https://qt.gtimg.cn/q=';
let liveTimer = null, watchTimer = null, secTimer = null, marketTimer = null, pfTimer = null;

function codeToSymbol(code) {
  code = (code || '').toString();
  if (/^9/.test(code) || /^6/.test(code)) return 'sh' + code;       // 沪市（含科创板 68）
  if (/^(00|30)/.test(code) || /^3/.test(code)) return 'sz' + code; // 深市（含创业板）
  if (/^(8|4)/.test(code)) return 'bj' + code;                      // 北交所
  return 'sh' + code;
}

// 指数用显式符号（000001 上证应为 sh，避免被 codeToSymbol 误判为 sz）
const INDEXES = [
  { sym: 'sh000001', name: '上证指数' },
  { sym: 'sz399001', name: '深证成指' },
  { sym: 'sz399006', name: '创业板指' },
  { sym: 'sh000300', name: '沪深300' },
  { sym: 'sh000688', name: '科创50' },
  { sym: 'sh000016', name: '上证50' },
];

function isTradingNow() {
  const d = new Date(), day = d.getDay();
  if (day === 0 || day === 6) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  return (hm >= 9 * 60 + 15 && hm <= 11 * 60 + 30) || (hm >= 13 * 60 && hm <= 15 * 60);
}

function parseSeg(seg) {
  const m = seg.match(/v_(\w+)="([^"]*)"/);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 35) return null;
  return {
    sym: m[1], code: f[2], name: f[1],
    price: parseFloat(f[3]), prevClose: parseFloat(f[4]), open: parseFloat(f[5]),
    high: parseFloat(f[33]), low: parseFloat(f[34]),
    change: parseFloat(f[31]), changePct: parseFloat(f[32]), time: f[30]
  };
}

// 按股票代码批量拉取
async function fetchLiveQuotes(codes) {
  if (!codes || !codes.length) return {};
  const url = LIVE_API + codes.map(codeToSymbol).join(',');
  const res = await fetch(url, { cache: 'no-store' });
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = {};
  text.split(';').forEach(seg => { const d = parseSeg(seg); if (d) out[d.code] = d; });
  return out;
}

// 按显式符号批量拉取（指数）
async function fetchLiveBySyms(syms) {
  if (!syms || !syms.length) return {};
  const res = await fetch(LIVE_API + syms.join(','), { cache: 'no-store' });
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = {};
  text.split(';').forEach(seg => { const d = parseSeg(seg); if (d) out[d.sym] = d; });
  return out;
}

function setLiveDot(on) {
  const d = $('liveDot'); if (!d) return;
  d.classList.toggle('on', !!on);
  d.title = on ? '实时行情已连接（腾讯财经）' : '实时行情连接中断，将自动重试';
}

function paintChange(elPrice, elChg, q) {
  if (!q || isNaN(q.price)) return;
  const c = q.change >= 0 ? UP : DOWN;
  if (elPrice) { elPrice.textContent = q.price.toFixed(2); elPrice.style.color = c; }
  if (elChg) {
    elChg.textContent = (q.change >= 0 ? '+' : '') + q.change.toFixed(2) + '  ' + (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%';
    elChg.style.color = c;
  }
}

function fmtHMS(t) {
  if (t && t.length >= 14) return t.slice(8, 10) + ':' + t.slice(10, 12) + ':' + t.slice(12, 14);
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function stopViewLive() {
  [liveTimer, secTimer, marketTimer, pfTimer].forEach(t => { if (t) clearInterval(t); });
  liveTimer = secTimer = marketTimer = pfTimer = null;
}

/* ---------------- 主题 ---------------- */
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  try { localStorage.setItem('theme', t); } catch (e) {}
  rerenderCharts();
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('theme') || 'light'; } catch (e) {}
  document.body.classList.toggle('dark', t === 'dark');
  $('themeBtn').addEventListener('click', () => applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark'));
}

/* ---------------- 初始化 ---------------- */
async function init() {
  initTheme();
  try {
    PORT = await api(STATIC_BASE + '/portfolio.json');
  } catch (e) {
    $('viewMarket').innerHTML = '<div class="empty">数据文件未就绪，请先运行 python export_static.py 生成 data-static/</div>';
    return;
  }
  const badge = $('srcBadge');
  badge.textContent = '实时行情 · 腾讯财经';
  badge.className = 'badge live';
  $('updatedAt').textContent = PORT.updated_at || '—';

  try { ALL_STOCKS = (await api(STATIC_BASE + '/stocks.json')).stocks; } catch (e) { ALL_STOCKS = []; }

  renderWatchlist(PORT.watchlist || []);
  startLiveWatchlist(PORT.watchlist || []);
  bindSearch();
  await loadSectors();
  bindNav();
  showView('market');
}

/* ---------------- 导航 / 路由 ---------------- */
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(n =>
    n.addEventListener('click', () => showView(n.dataset.view)));
  $('aiSend').addEventListener('click', () => aiAsk());
  $('aiInput').addEventListener('keydown', e => { if (e.key === 'Enter') aiAsk(); });
  renderAIChips();
}

function showView(v) {
  currentView = v;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
  const sec = $('view' + firstUpper(v));
  if (sec) sec.classList.add('active');
  const titles = { market: '市场看板', detail: '个股详情', ai: 'AI 问答', portfolio: '组合诊断' };
  $('crumbView').textContent = titles[v] || '';
  stopViewLive();
  if (v === 'market') renderMarket();
  else if (v === 'portfolio') renderPortfolio();
  else if (v === 'detail') { if (currentDetail) renderDetail(currentDetail); else showDetailHint(); }
}

/* ---------------- 侧边栏：自选股 ---------------- */
function renderWatchlist(list) {
  const el = $('watchlist');
  if (!list || !list.length) { el.innerHTML = ''; return; }
  el.innerHTML = list.map(s => {
    const c = s.change_pct >= 0 ? UP : DOWN;
    return `<div class="wl-item" id="wl-${s.code}" onclick="selectStock('${s.code}','${esc(s.name)}')">
      <div><div class="wl-name">${esc(s.name)}</div><div class="wl-code">${s.code}</div></div>
      <div class="wl-right">
        <div class="wl-price">${fmt(s.price)}</div>
        <div class="wl-chg" style="color:${c}">${s.change_pct == null ? '—' : sign(s.change_pct) + fmt(s.change_pct) + '%'}</div>
      </div>
    </div>`;
  }).join('');
}

function setActiveWatchlist(code) {
  document.querySelectorAll('.wl-item').forEach(e => e.classList.remove('active'));
  const el = $('wl-' + code);
  if (el) el.classList.add('active');
  $('crumbName').textContent = currentDetail ? currentDetail.name : '—';
}

/* ---------------- 侧边栏：板块导航 ---------------- */
function renderSectorNav(sectors) {
  if (!sectors || !sectors.length) { $('sectorNav').innerHTML = '<div class="muted" style="padding:6px">板块加载中…</div>'; return; }
  $('sectorNav').innerHTML = sectors.map(s => {
    const v = s.ret_20d;
    const c = v >= 0 ? UP : DOWN;
    return `<div class="sn-item" onclick="gotoSector('${esc(s.name)}')">
      <span class="sn-name">${esc(s.name)}</span>
      <span class="sn-ret" style="color:${c}">${v == null ? '—' : sign(v) + fmt(v) + '%'}</span>
    </div>`;
  }).join('');
}

function gotoSector(name) { showView('market'); openSector(name); }

/* ---------------- 搜索（本地模糊匹配） ---------------- */
function bindSearch() {
  const inp = $('search');
  inp.addEventListener('input', debounce(onSearch, 200));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = $('suggest').firstElementChild; if (f) f.click(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) $('suggest').style.display = 'none'; });
}
async function onSearch() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) { $('suggest').style.display = 'none'; return; }
  const res = (ALL_STOCKS || []).filter(s => s.code.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 30);
  const box = $('suggest');
  if (!res.length) { box.style.display = 'none'; return; }
  box.innerHTML = res.map(s => `<div class="sg" onclick="pickSearch('${s.code}','${esc(s.name)}')">
    <span class="sg-name">${esc(s.name)}</span><span class="sg-code">${s.code}</span><span class="sg-chg" id="sgc-${s.code}"></span><span class="sg-sec">${esc(s.sector || '')}</span></div>`).join('');
  box.style.display = 'block';
  fetchLiveQuotes(res.map(r => r.code)).then(q => res.forEach(s => {
    const el = $('sgc-' + s.code); if (!el || !q[s.code]) return;
    const d = q[s.code];
    el.textContent = (d.changePct >= 0 ? '+' : '') + d.changePct.toFixed(2) + '%';
    el.style.color = d.change >= 0 ? UP : DOWN;
  })).catch(() => {});
}
function pickSearch(code, name) {
  $('search').value = name;
  $('suggest').style.display = 'none';
  selectStock(code, name);
}

/* ---------------- 个股详情 ---------------- */
function selectStock(code, name) {
  showView('detail');
  $('search').value = name;
  $('suggest').style.display = 'none';
  $('detailSection').innerHTML = '<div class="empty">加载中…</div>';
  api(STATIC_BASE + '/stocks/' + code + '.json')
    .then(d => { currentDetail = d; renderDetail(d); setActiveWatchlist(code); })
    .catch(e => {
      $('detailSection').innerHTML = `<div class="empty">
        <p>「<b>${esc(name)}</b>」（${code}）未包含在开源静态演示版的预生成数据中。</p>
        <p class="muted">演示版仅内置 30 只自选 / 热门龙头的快照数据。完整全市场搜索、实时行情与每日自动刷新，请按仓库 README 用 Docker 自托管部署。</p>
      </div>`;
    });
}

function showDetailHint() {
  $('detailSection').innerHTML = '<div class="empty">在左侧搜索或点击自选股 / 板块，查看个股详情（K线 · 估值分位 · 同业对比 · 实时行情）。</div>';
}

function disposeCharts() {
  ['kline', 'pe', 'gauge', 'secIdx', 'pfIndustry'].forEach(k => {
    if (charts[k]) { try { charts[k].dispose(); } catch (e) {} delete charts[k]; }
  });
}

function renderDetail(d) {
  disposeCharts();
  const c = d.change_pct >= 0 ? UP : DOWN;
  const sec = d.sector_avg || {};
  const peerRows = (d.peers || []).map(p => `<tr>
    <td><a class="lk" onclick="selectStock('${p.code}','${esc(p.name)}')">${esc(p.name)}</a> <span class="muted-cell">${p.code}</span></td>
    <td style="color:${p.ret60 >= 0 ? UP : DOWN}">${p.ret60 == null ? '—' : sign(p.ret60) + fmt(p.ret60) + '%'}</td>
    <td>${fmt(p.pe)}</td><td>${fmt(p.pb)}</td></tr>`).join('');
  const pct = d.pe_percentile;

  $('detailSection').innerHTML = `
    <div class="detail-head">
      <div class="dh-left">
        <div class="d-name">${esc(d.name)} <span class="d-code">${d.code}</span></div>
        <div class="d-sector">所属行业：${esc(d.sector)}
          <span class="src-tag ${d.source === 'akshare' ? 'live' : 'sample'}">${d.source === 'akshare' ? '实时' : '样例'}</span>
        </div>
      </div>
      <div class="dh-right">
        <div class="d-price">
          <div class="d-px" id="dPx" style="color:${c}">${fmt(d.price)}</div>
          <div class="d-chg" id="dChg" style="color:${c}">${d.change_pct == null ? '—' : sign(d.change_pct) + fmt(d.change_pct) + '%'}</div>
        </div>
        <div class="d-live" id="dLive"></div>
        <div class="chips">
          <div class="chip"><div class="k">市盈率(TTM)</div><div class="v">${fmt(d.pe_ttm)}</div></div>
          <div class="chip"><div class="k">市净率</div><div class="v">${fmt(d.pb)}</div></div>
          <div class="chip"><div class="k">总市值</div><div class="v">${d.market_cap == null ? '—' : fmtBig(d.market_cap * 1e8)}</div></div>
        </div>
      </div>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-t">K线 · 近60日 <span class="sub">MA5 / MA20 · 成交量</span></div>
        <div id="kline" class="chart-lg"></div>
      </div>
      <div class="panel">
        <div class="panel-t">估值分位温度计 <span class="sub">越低越便宜</span></div>
        <div id="gauge" class="chart-md"></div>
        <div class="panel-t" style="margin-top:8px">市盈率历史 · 近120日</div>
        <div id="pe" class="chart-sm"></div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-t">基本面速览</div>
      <div class="kv">
        <div><span>市盈率(TTM)</span><b>${fmt(d.pe_ttm)}</b></div>
        <div><span>市净率</span><b>${fmt(d.pb)}</b></div>
        <div><span>ROE</span><b>${d.roe == null ? '—' : fmt(d.roe, 1) + '%'}</b></div>
        <div><span>总市值</span><b>${d.market_cap == null ? '—' : fmtBig(d.market_cap * 1e8)}</b></div>
        <div><span>营收(TTM)</span><b>${d.revenue_ttm == null ? '—' : fmtBig(d.revenue_ttm * 1e8)}</b></div>
        <div><span>净利润(TTM)</span><b>${d.net_profit_ttm == null ? '—' : fmtBig(d.net_profit_ttm * 1e8)}</b></div>
        <div><span>毛利率</span><b>${d.gross_margin == null ? '—' : fmt(d.gross_margin, 1) + '%'}</b></div>
        <div><span>行业均值(PE/PB)</span><b>${fmt(sec.pe)} / ${fmt(sec.pb)}</b></div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-t">同业对比 · ${esc(d.sector)} <span class="sub">行业均值 PE ${fmt(sec.pe)} / PB ${fmt(sec.pb)}</span></div>
      <table class="grid">
        <thead><tr><th>个股</th><th>60日收益</th><th>PE</th><th>PB</th></tr></thead>
        <tbody>${peerRows || '<tr><td colspan="4" class="muted-cell">该行业暂无同业可比数据</td></tr>'}</tbody>
      </table>
    </div>
  `;

  drawKline(d.ohlc || []);
  drawGauge(pct);
  drawPE(d.pe_history || []);
  setActiveWatchlist(d.code);
  startLiveDetail(d.code);
}

function drawKline(ohlc) {
  if (!ohlc.length) return;
  const tc = themeColors();
  const chart = charts.kline || (charts.kline = echarts.init($('kline')));
  const dates = ohlc.map(x => x.d);
  const k = ohlc.map(x => [x.o, x.c, x.l, x.h]);
  const closes = ohlc.map(x => x.c);
  const ma = (n) => closes.map((_, i) => i < n - 1 ? null : +(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n).toFixed(2));
  const vol = ohlc.map(x => x.v);
  chart.setOption({
    animation: false,
    grid: [{ left: 54, right: 18, top: 16, height: '60%' }, { left: 54, right: 18, top: '76%', height: '16%' }],
    xAxis: [{ type: 'category', data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: tc.split } } },
            { type: 'category', data: dates, axisLabel: { show: false } }],
    yAxis: [{ scale: true, splitLine: { lineStyle: { color: tc.split } }, axisLabel: { color: tc.text } },
            { scale: true, splitLine: { show: false }, axisLabel: { color: tc.text } }],
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      { name: 'K', type: 'candlestick', data: k, xAxisIndex: 0, yAxisIndex: 0,
        itemStyle: { color: tc.up, color0: tc.down, borderColor: tc.up, borderColor0: tc.down } },
      { name: 'MA5', type: 'line', data: ma(5), smooth: true, showSymbol: false, lineStyle: { width: 1, color: tc.accent } },
      { name: 'MA20', type: 'line', data: ma(20), smooth: true, showSymbol: false, lineStyle: { width: 1, color: tc.text } },
      { name: '量', type: 'bar', data: vol, xAxisIndex: 1, yAxisIndex: 1,
        itemStyle: { color: (p) => (ohlc[p.dataIndex].c >= ohlc[p.dataIndex].o ? tc.up : tc.down) } }
    ]
  });
}

function drawGauge(pct) {
  const el = $('gauge'); if (!el) return;
  const v = pct == null ? 0 : pct;
  const chart = charts.gauge || (charts.gauge = echarts.init(el));
  chart.setOption({
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 100,
      radius: '92%', center: ['50%', '58%'],
      progress: { show: false },
      axisLine: { lineStyle: { width: 16, color: [[0.33, DOWN], [0.66, '#d9941a'], [1, UP]] } },
      pointer: { icon: 'path://M2,0 L-2,0 L0,-56 Z', length: '62%', width: 5, itemStyle: { color: 'auto' } },
      axisTick: { distance: -16, length: 4, lineStyle: { color: '#fff', width: 1 } },
      splitLine: { distance: -16, length: 16, lineStyle: { color: '#fff', width: 2 } },
      axisLabel: { distance: -2, color: '#9aa2b5', fontSize: 10,
        formatter: (val) => (val === 0 ? '低' : val === 50 ? '中' : val === 100 ? '高' : '') },
      detail: { valueAnimation: true, fontSize: 26, fontWeight: 800, offsetCenter: [0, '34%'],
        formatter: (x) => (pct == null ? '—' : x.toFixed(1) + '%'), color: 'auto' },
      title: { offsetCenter: [0, '64%'], fontSize: 12, color: '#9aa2b5' },
      data: [{ value: v, name: pct == null ? '暂无数据' : (pct < 33 ? '低估' : pct < 66 ? '中性' : '偏高') }]
    }]
  });
}

function drawPE(hist) {
  const el = $('pe'); if (!el) return;
  const tc = themeColors();
  const chart = charts.pe || (charts.pe = echarts.init(el));
  const data = hist.filter(v => v != null);
  chart.setOption({
    animation: false,
    grid: { left: 44, right: 14, top: 14, bottom: 22 },
    xAxis: { type: 'category', data: data.map((_, i) => i + 1), axisLabel: { show: false }, axisLine: { lineStyle: { color: tc.split } } },
    yAxis: { scale: true, splitLine: { lineStyle: { color: tc.split } }, axisLabel: { color: tc.text } },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'line', data, showSymbol: false, lineStyle: { width: 1.5, color: tc.accent }, areaStyle: { color: 'rgba(37,99,235,.08)' } }]
  });
}

/* ---------------- 板块（数据 + 下钻） ---------------- */
async function loadSectors() {
  try {
    const data = await api(STATIC_BASE + '/sectors.json');
    currentSectors = data;
    renderSectorNav(data);
  } catch (e) { /* 静默 */ }
}

function heatColor(v) {
  if (v == null) return 'rgba(150,160,180,.18)';
  const a = Math.min(0.85, Math.abs(v) / 8);
  return v >= 0 ? `rgba(26,162,96,${a})` : `rgba(226,60,53,${a})`;
}

async function openSector(name) {
  const box = $('mSectorDetail');
  if (!box) { showView('market'); }
  const target = $('mSectorDetail');
  if (!target) return;
  target.style.display = 'block';
  target.innerHTML = `<div class="panel"><div class="panel-t">${esc(name)} · 板块指数走势与成分股</div>
    <div id="secIdx" class="chart-sm"></div><div id="secCons"></div></div>`;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const sec = (currentSectors || []).find(s => s.name === name);
    if (sec && sec.series) {
      const tc = themeColors();
      const c = echarts.init($('secIdx'));
      charts.secIdx = c;
      c.setOption({
        animation: false,
        grid: { left: 50, right: 16, top: 14, bottom: 26 },
        xAxis: { type: 'category', data: sec.series.map(x => x.d), axisLabel: { show: false }, axisLine: { lineStyle: { color: tc.split } } },
        yAxis: { scale: true, splitLine: { lineStyle: { color: tc.split } }, axisLabel: { color: tc.text } },
        tooltip: { trigger: 'axis' },
        series: [{ type: 'line', data: sec.series.map(x => x.v), showSymbol: false, lineStyle: { width: 1.5, color: tc.accent }, areaStyle: { color: 'rgba(37,99,235,.08)' } }]
      });
    }
    const cons = await api(STATIC_BASE + '/sectors/' + encodeURIComponent(name) + '.json');
    const rows = cons.map(m => `<tr>
      <td><a class="lk" onclick="selectStock('${m.code}','${esc(m.name)}')">${esc(m.name)}</a> <span class="muted-cell">${m.code}</span></td>
      <td id="secc-${m.code}-p" class="mono">—</td>
      <td id="secc-${m.code}-c" class="mono">—</td>
      <td style="color:${m.ret60 >= 0 ? UP : DOWN}">${m.ret60 == null ? '—' : sign(m.ret60) + fmt(m.ret60) + '%'}</td>
      <td>${fmt(m.pe)}</td><td>${fmt(m.pb)}</td></tr>`).join('');
    $('secCons').innerHTML = `<table class="grid"><thead><tr><th>成分股</th><th>现价</th><th>涨跌%</th><th>60日收益</th><th>PE</th><th>PB</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted-cell">无成分股数据</td></tr>'}</tbody></table>`;
    startLiveSector(cons.map(m => m.code));
  } catch (e) {
    $('secCons').innerHTML = '<div class="empty">加载失败</div>';
  }
}

/* ---------------- 市场看板 ---------------- */
function buildPool() {
  if (POOL) return POOL;
  const set = new Map();
  (PORT.watchlist || []).forEach(s => set.set(s.code, s));
  if (PORT.featured) set.set(PORT.featured.code, PORT.featured);
  POOL = [...set.values()];
  return POOL;
}

function renderMarket() {
  const secs = currentSectors || [];
  const pool = buildPool();
  $('viewMarket').innerHTML = `
    <div class="dash">
      <div class="idx-row" id="idxRow"><div class="muted">指数加载中…</div></div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-t">板块热力图 <span class="sub">近20日涨跌 · 点击下钻</span></div>
          <div class="heat" id="mHeat">${secs.length ? '' : '<div class="muted">板块加载中…</div>'}</div>
        </div>
        <div class="panel">
          <div class="panel-t">市场广度 <span class="sub">板块 + 自选热门池</span></div>
          <div id="mBreadth"></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-t">涨幅榜 <span class="sub">自选+热门池 · 实时</span></div>
          <table class="grid" id="mUp"><tbody><tr><td class="muted-cell">加载中…</td></tr></tbody></table>
        </div>
        <div class="panel">
          <div class="panel-t">跌幅榜 <span class="sub">实时</span></div>
          <table class="grid" id="mDown"><tbody><tr><td class="muted-cell">加载中…</td></tr></tbody></table>
        </div>
      </div>
      <div class="panel" style="margin-top:16px;display:none" id="mSectorDetail"></div>
    </div>`;

  // 板块热力图
  if (secs.length) {
    const sorted = [...secs].sort((a, b) => (b.ret_20d || 0) - (a.ret_20d || 0));
    $('mHeat').innerHTML = sorted.map(s => {
      const v = s.ret_20d;
      const c = v >= 0 ? UP : DOWN;
      const tc2 = Math.abs(v || 0) > 4 ? '#fff' : 'var(--text)';
      return `<div class="heat-tile" style="background:${heatColor(v)}" onclick="openSector('${esc(s.name)}')" title="${esc(s.name)} 近20日 ${v == null ? '—' : sign(v) + fmt(v) + '%'}">
        <div class="ht-name" style="color:${tc2}">${esc(s.name)}</div>
        <div class="ht-val" style="color:${Math.abs(v || 0) > 4 ? '#fff' : c}">${v == null ? '—' : sign(v) + fmt(v) + '%'}</div>
      </div>`;
    }).join('');
  }

  // 广度（板块）
  const upSec = secs.filter(s => (s.ret_20d || 0) >= 0).length;
  const downSec = secs.length - upSec;
  $('mBreadth').innerHTML = `
    <div class="breadth-block">
      <div class="bb-title">板块（共 ${secs.length}）</div>
      <div class="bb-bar"><div class="bb-up" style="width:${(upSec / secs.length * 100).toFixed(0)}%">${upSec}</div><div class="bb-dn">${downSec}</div></div>
      <div class="bb-legend"><span style="color:${UP}">▲ 上涨 ${upSec}</span><span style="color:${DOWN}">▼ 下跌 ${downSec}</span></div>
    </div>
    <div class="breadth-block" id="mBreadthStock"><div class="bb-title">个股（自选+热门池 ${pool.length}）</div><div class="muted">实时计算中…</div></div>`;

  // 指数 + 涨跌榜 + 个股广度：实时
  const tick = async () => {
    try {
      const idx = await fetchLiveBySyms(INDEXES.map(x => x.sym));
      $('idxRow').innerHTML = INDEXES.map(x => {
        const d = idx[x.sym];
        if (!d) return `<div class="idx-card"><div class="idx-name">${x.name}</div><div class="muted">—</div></div>`;
        const c = d.change >= 0 ? UP : DOWN;
        return `<div class="idx-card">
          <div class="idx-name">${x.name}</div>
          <div class="idx-px" style="color:${c}">${d.price.toFixed(2)}</div>
          <div class="idx-chg" style="color:${c}">${sign(d.change)}${d.change.toFixed(2)}  ${sign(d.changePct)}${d.changePct.toFixed(2)}%</div>
        </div>`;
      }).join('');

      const q = await fetchLiveQuotes(pool.map(s => s.code));
      const live = pool.map(s => ({ ...s, live: q[s.code] })).filter(s => s.live && !isNaN(s.live.price));
      const ranked = [...live].sort((a, b) => b.live.changePct - a.live.changePct);
      const upN = live.filter(s => s.live.change >= 0).length;
      const dnN = live.length - upN;
      $('mBreadthStock').innerHTML = `
        <div class="bb-title">个股（自选+热门池 ${live.length}）</div>
        <div class="bb-bar"><div class="bb-up" style="width:${(upN / live.length * 100).toFixed(0)}%">${upN}</div><div class="bb-dn">${dnN}</div></div>
        <div class="bb-legend"><span style="color:${UP}">▲ 上涨 ${upN}</span><span style="color:${DOWN}">▼ 下跌 ${dnN}</span></div>`;
      const rowOf = (s) => `<tr onclick="selectStock('${s.code}','${esc(s.name)}')" style="cursor:pointer">
        <td>${esc(s.name)}</td>
        <td class="mono">${s.live.price.toFixed(2)}</td>
        <td class="mono" style="color:${s.live.change >= 0 ? UP : DOWN}">${sign(s.live.changePct)}${s.live.changePct.toFixed(2)}%</td></tr>`;
      const up = ranked.slice(0, 8), down = ranked.slice(-8).reverse();
      $('mUp').innerHTML = `<thead><tr><th>名称</th><th>现价</th><th>涨跌%</th></tr></thead><tbody>${up.map(rowOf).join('') || '<tr><td colspan="3" class="muted-cell">—</td></tr>'}</tbody>`;
      $('mDown').innerHTML = `<thead><tr><th>名称</th><th>现价</th><th>涨跌%</th></tr></thead><tbody>${down.map(rowOf).join('') || '<tr><td colspan="3" class="muted-cell">—</td></tr>'}</tbody>`;
      $('lastRefresh').textContent = fmtHMS(ranked[0] && ranked[0].live ? ranked[0].live.time : '');
      setLiveDot(true);
    } catch (e) { setLiveDot(false); }
  };
  tick();
  marketTimer = setInterval(() => { if (!document.hidden) tick(); }, isTradingNow() ? 12000 : 30000);
}

/* ---------------- 个股详情实时 ---------------- */
function startLiveDetail(code) {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  const tick = async () => {
    try {
      const q = await fetchLiveQuotes([code]); const d = q[code];
      if (d) {
        paintChange($('dPx'), $('dChg'), d);
        const t = $('dLive');
        if (t) t.innerHTML = `<span>今开 <b>${d.open.toFixed(2)}</b></span><span>最高 <b>${d.high.toFixed(2)}</b></span><span>最低 <b>${d.low.toFixed(2)}</b></span><span>昨收 <b>${d.prevClose.toFixed(2)}</b></span>`;
        const lr = $('lastRefresh'); if (lr) lr.textContent = fmtHMS(d.time);
        setLiveDot(true);
      }
    } catch (e) { setLiveDot(false); }
  };
  tick();
  liveTimer = setInterval(() => { if (!document.hidden) tick(); }, isTradingNow() ? 10000 : 30000);
}

function startLiveWatchlist(list) {
  const codes = (list || []).map(s => s.code);
  if (!codes.length || watchTimer) return;
  const tick = async () => {
    try {
      const q = await fetchLiveQuotes(codes);
      list.forEach(s => {
        const el = $('wl-' + s.code); if (!el) return;
        paintChange(el.querySelector('.wl-price'), el.querySelector('.wl-chg'), q[s.code]);
      });
      setLiveDot(true);
    } catch (e) { setLiveDot(false); }
  };
  tick();
  watchTimer = setInterval(() => { if (!document.hidden) tick(); }, isTradingNow() ? 12000 : 30000);
}

function startLiveSector(codes) {
  if (secTimer) { clearInterval(secTimer); secTimer = null; }
  if (!codes || !codes.length) return;
  const tick = async () => {
    try {
      const q = await fetchLiveQuotes(codes);
      codes.forEach(code => {
        const d = q[code]; if (!d) return;
        const p = $('secc-' + code + '-p'), c = $('secc-' + code + '-c');
        if (!p || !c) return;
        const col = d.change >= 0 ? UP : DOWN;
        p.textContent = d.price.toFixed(2); p.style.color = col;
        c.textContent = (d.changePct >= 0 ? '+' : '') + d.changePct.toFixed(2) + '%'; c.style.color = col;
      });
    } catch (e) {}
  };
  tick();
  secTimer = setInterval(() => { if (!document.hidden) tick(); }, isTradingNow() ? 12000 : 30000);
}

/* ---------------- AI 问答（端侧规则+数据） ---------------- */
function renderAIChips() {
  const chips = [
    '今天大盘怎么样？',
    '贵州茅台现在估值贵吗？',
    '比亚迪近期表现如何？',
    '宁德时代基本面怎么样？',
    '白酒板块和半导体板块哪个更强？'
  ];
  $('aiChips').innerHTML = chips.map(c => `<span class="ai-chip" onclick="aiAsk('${esc(c)}')">${esc(c)}</span>`).join('');
}

function matchStock(q) {
  q = q.trim();
  if (/^\d{6}$/.test(q)) {
    const s = (ALL_STOCKS || []).find(x => x.code === q);
    return s ? { code: s.code, name: s.name } : { code: q, name: q };
  }
  // 问句中直接出现 6 位代码，如「600519 估值贵吗」
  const codeIn = q.match(/\d{6}/);
  if (codeIn) {
    const s = (ALL_STOCKS || []).find(x => x.code === codeIn[0]);
    if (s) return { code: s.code, name: s.name };
  }
  const lower = q.toLowerCase();
  // 完全等于股票名
  const exact = (ALL_STOCKS || []).find(s => s.name === q || s.name.toLowerCase() === lower);
  if (exact) return { code: exact.code, name: exact.name };
  // 关键：股票名出现在问句中（如「贵州茅台现在估值贵吗？」），取最长匹配，先自选/热门池、再全市场
  const pool = [...(PORT && PORT.featured ? [PORT.featured] : []), ...((PORT && PORT.watchlist) || [])];
  const inPool = pool.filter(s => s.name && s.name.length >= 2 && q.includes(s.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (inPool) return { code: inPool.code, name: inPool.name };
  const inAll = (ALL_STOCKS || []).filter(s => s.name && s.name.length >= 2 && q.includes(s.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (inAll) return { code: inAll.code, name: inAll.name };
  // 反向：股票名包含问句（用户只打了名字片段）
  const part = (ALL_STOCKS || []).find(s => lower.length >= 2 && s.name.toLowerCase().includes(lower));
  if (part) return { code: part.code, name: part.name };
  return null;
}

function detectIntent(q) {
  if (/大盘|市场|今天|指数|行情|整体|盘面|上证|创业板/.test(q)) return 'market';
  if (/对比|和|还是|pk|比较|谁好|更强|哪个/.test(q)) return 'compare';
  if (/估值|贵|便宜|高估|低估|合理|市盈率|分位|pe/.test(q)) return 'valuation';
  if (/基本面|财务|营收|利润|毛利|roe|业绩|赚钱|负债/.test(q)) return 'fundamental';
  if (/涨跌|表现|走势|近期|最近|怎么样|如何|好不好|涨|跌|风险/.test(q)) return 'performance';
  return 'general';
}

async function loadDetailIfAny(code) {
  try { return await api(STATIC_BASE + '/stocks/' + code + '.json'); } catch (e) { return null; }
}

async function aiAsk(raw) {
  const q = (raw || (raw === undefined ? $('aiInput').value : raw) || '').trim();
  if (!q) return;
  if (raw !== undefined) $('aiInput').value = raw;
  const answer = $('aiAnswer');
  answer.innerHTML = '<div class="ai-think">分析中…</div>';
  const stock = matchStock(q);
  // 先剔除股票名再判定意图，避免股名中的字（如「贵」州茅台）误触发「估值贵」等意图
  const qForIntent = (stock && stock.name) ? q.split(stock.name).join(' ') : q;
  const intent = detectIntent(qForIntent);
  let html = `<div class="ai-q">${esc(q)}</div>`;
  try {
    if (intent === 'market') html += await aiMarket();
    else if (intent === 'compare') html += await aiCompare(q);
    else if (stock) html += await aiStock(stock, intent, q);
    else html += `<div class="ai-body">没太理解你的问题～可以试试问我：<br>· 贵州茅台现在估值贵吗？<br>· 今天大盘怎么样？<br>· 比亚迪近期表现如何？<br>· 白酒板块和半导体板块哪个更强？</div>`;
  } catch (e) {
    html += `<div class="ai-body">分析时出错：${esc(e.message)}</div>`;
  }
  answer.innerHTML = html;
  answer.scrollTop = 0;
}

function stockCard(d, live) {
  const c = (live && !isNaN(live.change)) ? (live.change >= 0 ? UP : DOWN) : (d.change_pct >= 0 ? UP : DOWN);
  const px = live && !isNaN(live.price) ? live.price.toFixed(2) : fmt(d.price);
  const chg = live && !isNaN(live.changePct) ? (sign(live.changePct) + live.changePct.toFixed(2) + '%') : (d.change_pct == null ? '—' : sign(d.change_pct) + fmt(d.change_pct) + '%');
  return `<div class="ai-stock">
    <div class="ai-stock-h"><b>${esc(d.name)}</b> <span class="muted-cell">${d.code}</span></div>
    <div class="ai-stock-px" style="color:${c}">${px} <span class="ai-stock-chg">${chg}</span></div>
    <div class="ai-stock-sub">市盈率(TTM) ${fmt(d.pe_ttm)} · 市净率 ${fmt(d.pb)} · 总市值 ${d.market_cap == null ? '—' : fmtBig(d.market_cap * 1e8)}</div>
  </div>`;
}

async function aiStock(stock, intent, q) {
  const d = await loadDetailIfAny(stock.code);
  const live = (await fetchLiveQuotes([stock.code]))[stock.code];
  let body = '';
  if (!d) {
    body += `<div class="ai-body">已为你定位到 <b>${esc(stock.name)}</b>（${stock.code}）。`;
    if (live && !isNaN(live.price)) body += ` 当前实时价 <b style="color:${live.change >= 0 ? UP : DOWN}">${live.price.toFixed(2)}</b>（${sign(live.changePct)}${live.changePct.toFixed(2)}%）。`;
    body += ` 不过该股的深度快照（K线/估值/同业）未包含在开源演示版的 30 只预生成数据中。完整分析请按仓库 README 用 Docker 自托管部署。</div>`;
    return body;
  }
  body += stockCard(d, live);
  if (intent === 'valuation') {
    const pct = d.pe_percentile;
    const verdict = pct == null ? '暂无估值分位数据' : (pct < 33 ? '处于历史<b style="color:' + DOWN + '">低估</b>区间' : pct < 66 ? '估值<b>中性</b>' : '处于历史<b style="color:' + UP + '">偏高</b>区间');
    const sec = d.sector_avg || {};
    body += `<div class="ai-body"><b>估值诊断：</b>${verdict}（PE 分位 ${pct == null ? '—' : pct.toFixed(1) + '%'}）。
      当前市盈率(TTM) <b>${fmt(d.pe_ttm)}</b>，行业均值 <b>${fmt(sec.pe)}</b>；市净率 <b>${fmt(d.pb)}</b>，行业均值 <b>${fmt(sec.pb)}</b>。
      ${d.pe_ttm != null && sec.pe ? (d.pe_ttm > sec.pe ? '相对行业<b>偏贵</b>。' : '相对行业<b>便宜</b>。') : ''}
      <div class="ai-note">结论：${pct == null ? '建议结合 ROE 与成长性综合判断' : (pct < 33 ? '安全边际较高，可重点跟踪' : pct > 66 ? '注意回撤风险，避免追高' : '估值合理，等待催化')}。</div></div>`;
  } else if (intent === 'fundamental') {
    body += `<div class="ai-body"><b>基本面速览（${esc(d.sector)}）：</b>
      <div class="kv kv-sm">
        <div><span>ROE</span><b>${d.roe == null ? '—' : fmt(d.roe, 1) + '%'}</b></div>
        <div><span>毛利率</span><b>${d.gross_margin == null ? '—' : fmt(d.gross_margin, 1) + '%'}</b></div>
        <div><span>营收(TTM)</span><b>${d.revenue_ttm == null ? '—' : fmtBig(d.revenue_ttm * 1e8)}</b></div>
        <div><span>净利(TTM)</span><b>${d.net_profit_ttm == null ? '—' : fmtBig(d.net_profit_ttm * 1e8)}</b></div>
      </div>
      <div class="ai-note">${d.roe != null && d.roe > 15 ? 'ROE 高于 15%，盈利能力较强。' : '盈利质量建议结合现金流进一步验证。'}毛利率${d.gross_margin != null && d.gross_margin > 40 ? '较高，具备一定护城河。' : '中等，关注成本控制。'}</div></div>`;
  } else if (intent === 'performance') {
    const r20 = d.ret_20d, r60 = d.ret_60d;
    const liveNote = (live && !isNaN(live.changePct)) ? ('今日实时 ' + (live.changePct >= 0 ? '上涨' : '下跌') + ' ' + Math.abs(live.changePct).toFixed(2) + '%。') : '';
    const trendNote = (r60 == null) ? '' : (r60 >= 0 ? '中期趋势偏强，注意高位波动。' : '中期处于调整，关注支撑与基本面变化。');
    body += `<div class="ai-body"><b>近期表现：</b>近20日 ${r20 == null ? '—' : sign(r20) + fmt(r20) + '%'}，近60日 ${r60 == null ? '—' : sign(r60) + fmt(r60) + '%'}。${liveNote}
      <div class="ai-note">${trendNote}</div></div>`;
  } else {
    const pct = d.pe_percentile;
    const pctTxt = pct == null ? '—' : pct.toFixed(1) + '%' + (pct < 33 ? '（偏低）' : pct > 66 ? '（偏高）' : '（中性）');
    const liveNote = (live && !isNaN(live.changePct)) ? ('实时 ' + sign(live.changePct) + live.changePct.toFixed(2) + '%。') : '';
    body += `<div class="ai-body"><b>综合解读：</b>
      所属 <b>${esc(d.sector)}</b>；估值分位 ${pctTxt}，近60日收益 ${d.ret_60d == null ? '—' : sign(d.ret_60d) + fmt(d.ret_60d) + '%'}。${liveNote}
      <div class="ai-note">可进一步问我「估值贵吗」「基本面怎么样」「近期表现如何」获取专项分析。</div></div>`;
  }
  body += `<div class="ai-disclaim">以上基于公开数据与快照，仅供参考，不构成投资建议。</div>`;
  return body;
}

async function aiMarket() {
  const idx = await fetchLiveBySyms(INDEXES.map(x => x.sym));
  const secs = currentSectors || [];
  const upSec = secs.filter(s => (s.ret_20d || 0) >= 0).length;
  const strong = [...secs].sort((a, b) => (b.ret_20d || 0) - (a.ret_20d || 0)).slice(0, 3);
  const weak = [...secs].sort((a, b) => (a.ret_20d || 0) - (b.ret_20d || 0)).slice(0, 3);
  let html = '<div class="ai-body"><b>大盘实时概览：</b><div class="ai-idx">';
  INDEXES.forEach(x => {
    const d = idx[x.sym];
    if (!d) return;
    const c = d.change >= 0 ? UP : DOWN;
    html += `<span class="ai-idx-item"><b>${x.name}</b> <span style="color:${c}">${d.price.toFixed(2)} ${sign(d.changePct)}${d.changePct.toFixed(2)}%</span></span>`;
  });
  html += '</div>';
  if (secs.length) {
    html += `板块层面：近20日 <b style="color:${UP}">${upSec}</b> 个上涨、<b style="color:${DOWN}">${secs.length - upSec}</b> 个下跌。
      强势板块：${strong.map(s => esc(s.name) + (s.ret_20d == null ? '' : ' ' + sign(s.ret_20d) + fmt(s.ret_20d) + '%')).join('、')}；
      弱势板块：${weak.map(s => esc(s.name) + (s.ret_20d == null ? '' : ' ' + sign(s.ret_20d) + fmt(s.ret_20d) + '%')).join('、')}。`;
  }
  html += `<div class="ai-note">注：指数为实时价；板块为构建快照（近20日），详见左侧「市场看板」。</div></div>`;
  html += `<div class="ai-disclaim">数据仅供参考，不构成投资建议。</div>`;
  return html;
}

async function aiCompare(q) {
  const a = matchStock(q);
  let b = null;
  const pool = [...(PORT.watchlist || []), ...(PORT.featured ? [PORT.featured] : [])];
  for (const s of pool.concat(ALL_STOCKS || [])) {
    if (s.name && s.name.length >= 2 && s.name !== (a && a.name) && q.includes(s.name) && q.indexOf(s.name) !== q.indexOf(a && a.name)) { b = { code: s.code, name: s.name }; break; }
  }
  if (!b) {
    const secHit = (currentSectors || []).filter(s => q.includes(s.name));
    if (secHit.length >= 2) {
      const x = secHit[0], y = secHit[1];
      return `<div class="ai-body"><b>板块对比：${esc(x.name)} vs ${esc(y.name)}</b><br>
        ${esc(x.name)} 近20日 <b style="color:${x.ret_20d >= 0 ? UP : DOWN}">${x.ret_20d == null ? '—' : sign(x.ret_20d) + fmt(x.ret_20d) + '%'}</b>，近60日 <b style="color:${x.ret_60d >= 0 ? UP : DOWN}">${x.ret_60d == null ? '—' : sign(x.ret_60d) + fmt(x.ret_60d) + '%'}</b>；<br>
        ${esc(y.name)} 近20日 <b style="color:${y.ret_20d >= 0 ? UP : DOWN}">${y.ret_20d == null ? '—' : sign(y.ret_20d) + fmt(y.ret_20d) + '%'}</b>，近60日 <b style="color:${y.ret_60d >= 0 ? UP : DOWN}">${y.ret_60d == null ? '—' : sign(y.ret_60d) + fmt(y.ret_60d) + '%'}</b>。<br>
        <div class="ai-note">近20日${x.ret_20d >= y.ret_20d ? esc(x.name) + '更强' : esc(y.name) + '更强'}；中长期看${x.ret_60d >= y.ret_60d ? esc(x.name) : esc(y.name)}占优。</div></div>
        <div class="ai-disclaim">板块为构建快照，仅供参考。</div>`;
    }
    return `<div class="ai-body">我识别出 ${a ? '「' + esc(a.name) + '」' : '一个标的'}，但没能定位到第二个对比对象。可以换个说法，如「贵州茅台和宁德时代哪个更强？」</div>`;
  }
  const da = await loadDetailIfAny(a.code);
  const db = await loadDetailIfAny(b.code);
  const la = (await fetchLiveQuotes([a.code]))[a.code];
  const lb = (await fetchLiveQuotes([b.code]))[b.code];
  let html = `<div class="ai-body"><b>个股对比：${esc(a.name)} vs ${esc(b.name)}</b>`;
  if (da) html += stockCard(da, la);
  else html += `<div class="muted-cell">${esc(a.name)} 无深度快照</div>` + (la ? ` 实时 ${la.price.toFixed(2)}（${sign(la.changePct)}${la.changePct.toFixed(2)}%）` : '');
  if (db) html += stockCard(db, lb);
  else html += `<div class="muted-cell">${esc(b.name)} 无深度快照</div>` + (lb ? ` 实时 ${lb.price.toFixed(2)}（${sign(lb.changePct)}${lb.changePct.toFixed(2)}%）` : '');
  const pa = da ? da.pe_ttm : null, pb = db ? db.pe_ttm : null;
  if (pa != null && pb != null) html += `<div class="ai-note">估值上 ${pa <= pb ? esc(a.name) + '更便宜（PE ' + fmt(pa) + ' vs ' + fmt(pb) + '）' : esc(b.name) + '更便宜（PE ' + fmt(pb) + ' vs ' + fmt(pa) + '）'}。</div>`;
  html += `<div class="ai-disclaim">数据仅供参考，不构成投资建议。</div>`;
  return html;
}

/* ---------------- 组合诊断 ---------------- */
function renderPortfolio() {
  const list = PORT.watchlist || [];
  const box = $('viewPortfolio');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无自选股组合。</div>'; return; }

  const bySec = {};
  list.forEach(s => { const k = s.sector || '其他'; bySec[k] = (bySec[k] || 0) + 1; });
  const secArr = Object.entries(bySec).sort((a, b) => b[1] - a[1]);
  const topSec = secArr.slice(0, 3);
  const topSecShare = topSec.reduce((a, x) => a + x[1], 0) / list.length * 100;

  const pes = list.map(s => s.pe).filter(v => v != null), pbs = list.map(s => s.pb).filter(v => v != null);
  const avgPE = pes.length ? pes.reduce((a, b) => a + b, 0) / pes.length : null;
  const avgPB = pbs.length ? pbs.reduce((a, b) => a + b, 0) / pbs.length : null;

  const r20 = list.map(s => s.ret_20d).filter(v => v != null);
  const r60 = list.map(s => s.ret_60d).filter(v => v != null);
  const avgR20 = r20.length ? r20.reduce((a, b) => a + b, 0) / r20.length : null;
  const avgR60 = r60.length ? r60.reduce((a, b) => a + b, 0) / r60.length : null;

  const diag = [];
  diag.push(`组合共 <b>${list.length}</b> 只，覆盖 <b>${secArr.length}</b> 个行业，前三大行业占比 <b>${topSecShare.toFixed(0)}%</b>（${topSec.map(x => x[0]).join('、')}），集中度${topSecShare > 60 ? '偏高' : topSecShare > 40 ? '适中' : '较分散'}。`);
  diag.push(`平均市盈率 <b>${avgPE == null ? '—' : fmt(avgPE)}</b>、平均市净率 <b>${avgPB == null ? '—' : fmt(avgPB)}</b>，整体估值${avgPE == null ? '数据不足' : avgPE > 35 ? '偏贵' : avgPE < 20 ? '偏低' : '中性'}。`);
  diag.push(`近20日平均收益 <b style="color:${avgR20 >= 0 ? UP : DOWN}">${avgR20 == null ? '—' : sign(avgR20) + fmt(avgR20) + '%'}</b>，近60日 <b style="color:${avgR60 >= 0 ? UP : DOWN}">${avgR60 == null ? '—' : sign(avgR60) + fmt(avgR60) + '%'}</b>，中期${avgR60 >= 0 ? '走势偏强' : '处于调整'}。`);
  const risk = topSecShare > 60 ? '行业集中度较高，单一板块回调会明显拖累组合，建议适度分散。' : '行业分布相对均衡，抗单一板块风险能力较好。';
  diag.push(risk);

  box.innerHTML = `
    <div class="dash">
      <div class="summary-row">
        <div class="sum-card"><div class="sum-k">持仓数</div><div class="sum-v">${list.length}</div><div class="sum-s">${secArr.length} 个行业</div></div>
        <div class="sum-card"><div class="sum-k">平均 PE</div><div class="sum-v">${avgPE == null ? '—' : fmt(avgPE)}</div><div class="sum-s">PB ${avgPB == null ? '—' : fmt(avgPB)}</div></div>
        <div class="sum-card"><div class="sum-k">近20日</div><div class="sum-v" style="color:${avgR20 >= 0 ? UP : DOWN}">${avgR20 == null ? '—' : sign(avgR20) + fmt(avgR20) + '%'}</div><div class="sum-s">平均收益</div></div>
        <div class="sum-card"><div class="sum-k">近60日</div><div class="sum-v" style="color:${avgR60 >= 0 ? UP : DOWN}">${avgR60 == null ? '—' : sign(avgR60) + fmt(avgR60) + '%'}</div><div class="sum-s">平均收益</div></div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-t">行业分布</div>
          <div id="pfIndustry" class="chart-md"></div>
        </div>
        <div class="panel">
          <div class="panel-t">组合诊断</div>
          <div class="diag">${diag.map(d => `<div class="diag-row">${d}</div>`).join('')}</div>
          <div class="ai-disclaim" style="margin-top:10px">以上基于快照数据，实时涨跌以持仓表为准；仅供参考，不构成投资建议。</div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-t">持仓明细 <span class="sub">实时涨跌</span></div>
        <table class="grid" id="pfTable"><thead><tr><th>名称</th><th>行业</th><th>现价</th><th>涨跌%</th><th>PE</th><th>PB</th><th>近60日</th></tr></thead><tbody></tbody></table>
      </div>
    </div>`;

  const tc = themeColors();
  const pie = charts.pfIndustry || (charts.pfIndustry = echarts.init($('pfIndustry')));
  const palette = [tc.accent, tc.accent2, '#14b8a6', '#f59e0b', '#a855f7', '#ec4899', '#64748b', '#0d9488'];
  pie.setOption({
    animation: false,
    tooltip: { trigger: 'item', formatter: '{b}: {c} 只 ({d}%)' },
    legend: { type: 'scroll', orient: 'vertical', right: 0, top: 10, textStyle: { color: tc.text, fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['42%', '70%'], center: ['38%', '52%'],
      itemStyle: { borderColor: 'var(--surface)', borderWidth: 2 },
      label: { show: false },
      data: secArr.map((x, i) => ({ name: x[0], value: x[1], itemStyle: { color: palette[i % palette.length] } }))
    }]
  });

  const pfTick = async () => {
    try {
      const q = await fetchLiveQuotes(list.map(s => s.code));
      const rows = list.map(s => {
        const d = q[s.code];
        const c = d && !isNaN(d.change) ? (d.change >= 0 ? UP : DOWN) : (s.change_pct >= 0 ? UP : DOWN);
        const px = d && !isNaN(d.price) ? d.price.toFixed(2) : fmt(s.price);
        const chg = d && !isNaN(d.changePct) ? (sign(d.changePct) + d.changePct.toFixed(2) + '%') : (s.change_pct == null ? '—' : sign(s.change_pct) + fmt(s.change_pct) + '%');
        return `<tr onclick="selectStock('${s.code}','${esc(s.name)}')" style="cursor:pointer">
          <td>${esc(s.name)}</td><td class="muted-cell">${esc(s.sector || '')}</td>
          <td class="mono">${px}</td>
          <td class="mono" style="color:${c}">${chg}</td>
          <td class="mono">${fmt(s.pe)}</td><td class="mono">${fmt(s.pb)}</td>
          <td class="mono" style="color:${s.ret_60d >= 0 ? UP : DOWN}">${s.ret_60d == null ? '—' : sign(s.ret_60d) + fmt(s.ret_60d) + '%'}</td>
        </tr>`;
      }).join('');
      const tb = $('pfTable').querySelector('tbody');
      if (tb) tb.innerHTML = rows;
      const lr = $('lastRefresh'); if (lr && list[0] && q[list[0].code]) lr.textContent = fmtHMS(q[list[0].code].time);
      setLiveDot(true);
    } catch (e) { setLiveDot(false); }
  };
  pfTick();
  pfTimer = setInterval(() => { if (!document.hidden) pfTick(); }, isTradingNow() ? 12000 : 30000);
}

/* ---------------- 主题切换时重绘图表 ---------------- */
function rerenderCharts() {
  if (currentView === 'detail' && currentDetail) {
    drawKline(currentDetail.ohlc || []);
    drawGauge(currentDetail.pe_percentile);
    drawPE(currentDetail.pe_history || []);
  }
  if (currentView === 'portfolio' && PORT && PORT.watchlist) renderPortfolio();
  if (currentView === 'market' && currentSectors) renderMarket();
}

/* ---------------- 工具 ---------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
window.addEventListener('resize', () => { Object.values(charts).forEach(c => c && c.resize()); });

init();
