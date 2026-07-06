/* 股票投研看板 · 开源静态演示版 前端逻辑
数据全部来自本地静态 JSON（由 export_static.py 从数据库导出）：
  ./data-static/portfolio.json    首屏快照
  ./data-static/stocks.json      全市场搜索列表（5527 只）
  ./data-static/sectors.json     板块指数表现
  ./data-static/stocks/<code>.json  预生成个股详情（自选+热门龙头）
  ./data-static/sectors/<name>.json 板块下钻成分股
该版本不含后端/实时拉取/定时刷新，为开源演示快照。
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

// 主题感知的图表配色
function themeColors() {
  const dark = document.body.classList.contains('dark');
  return {
    text: dark ? '#9aa3ba' : '#6b7488',
    axis: dark ? '#3a4360' : '#e6e9f0',
    split: dark ? 'rgba(255,255,255,.06)' : '#eef1f7',
    up: dark ? '#ff5a52' : '#e23c35',
    down: dark ? '#25c281' : '#1aa260',
    accent: dark ? '#6d72f0' : '#4f46e5',
  };
}

let PORT = null;
let charts = {};
let currentDetail = null;
let currentSectors = null;
let ALL_STOCKS = null;

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
    $('detailSection').innerHTML = '<div class="empty">数据文件未就绪，请先运行 python export_static.py 生成 data-static/</div>';
    return;
  }
  const live = PORT.data_source === 'akshare';
  const badge = $('srcBadge');
  badge.textContent = live ? '实时数据 · AkShare' : '样例数据';
  badge.className = 'badge ' + (live ? 'live' : 'sample');
  $('updatedAt').textContent = PORT.updated_at || '—';
  $('lastRefresh').textContent = PORT.static ? '静态快照' : (PORT.last_refresh || '—');

  // 静态演示版无后端刷新，隐藏刷新按钮
  const rb = $('refreshBtn');
  if (rb) rb.style.display = 'none';

  // 预加载全市场搜索列表（本地模糊匹配）
  try { ALL_STOCKS = (await api(STATIC_BASE + '/stocks.json')).stocks; } catch (e) { ALL_STOCKS = []; }

  renderWatchlist(PORT.watchlist || []);
  if (PORT.featured) { currentDetail = PORT.featured; renderDetail(PORT.featured); }
  bindSearch();
  loadSectors();
}

/* ---------------- 侧边栏：自选股 ---------------- */
function renderWatchlist(list) {
  const el = $('watchlist');
  if (!list || !list.length) { el.innerHTML = ''; return; }
  el.innerHTML = list.map(s => {
    const c = s.change_pct >= 0 ? UP : DOWN;
    return `<div class="wl-item" id="wl-${s.code}" onclick="selectStock('${s.code}','${s.name}')">
      <div><div class="wl-name">${s.name}</div><div class="wl-code">${s.code}</div></div>
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
    return `<div class="sn-item" onclick="scrollToSector('${s.name.replace(/'/g, "\\'")}')">
      <span class="sn-name">${s.name}</span>
      <span class="sn-ret" style="color:${c}">${v == null ? '—' : sign(v) + fmt(v) + '%'}</span>
    </div>`;
  }).join('');
}

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
  box.innerHTML = res.map(s => `<div class="sg" onclick="pickSearch('${s.code}','${s.name.replace(/'/g, "\\'")}')">
    <span class="sg-name">${s.name}</span><span class="sg-code">${s.code}</span><span class="sg-sec">${s.sector || ''}</span></div>`).join('');
  box.style.display = 'block';
}
function pickSearch(code, name) {
  $('search').value = name;
  $('suggest').style.display = 'none';
  selectStock(code, name);
}

/* ---------------- 个股详情（静态） ---------------- */
function selectStock(code, name) {
  $('search').value = name;
  $('suggest').style.display = 'none';
  $('detailSection').innerHTML = '<div class="empty">加载中…</div>';
  api(STATIC_BASE + '/stocks/' + code + '.json')
    .then(d => { currentDetail = d; renderDetail(d); setActiveWatchlist(code); })
    .catch(e => {
      $('detailSection').innerHTML = `<div class="empty">
        <p>「<b>${name}</b>」（${code}）未包含在开源静态演示版的预生成数据中。</p>
        <p class="muted">演示版仅内置 30 只自选 / 热门龙头的快照数据。完整全市场搜索、实时行情与每日自动刷新，请按仓库 README 用 Docker 自托管部署。</p>
      </div>`;
    });
}

function disposeCharts() {
  ['kline', 'pe', 'gauge', 'secIdx'].forEach(k => {
    if (charts[k]) { try { charts[k].dispose(); } catch (e) {} delete charts[k]; }
  });
}

function renderDetail(d) {
  disposeCharts();
  const c = d.change_pct >= 0 ? UP : DOWN;
  const sec = d.sector_avg || {};
  const peerRows = (d.peers || []).map(p => `<tr>
    <td><a class="lk" onclick="selectStock('${p.code}','${p.name}')">${p.name}</a> <span class="muted-cell">${p.code}</span></td>
    <td style="color:${p.ret60 >= 0 ? UP : DOWN}">${p.ret60 == null ? '—' : sign(p.ret60) + fmt(p.ret60) + '%'}</td>
    <td>${fmt(p.pe)}</td><td>${fmt(p.pb)}</td></tr>`).join('');
  const pct = d.pe_percentile;

  $('detailSection').innerHTML = `
    <div class="detail-head">
      <div class="dh-left">
        <div class="d-name">${d.name} <span class="d-code">${d.code}</span></div>
        <div class="d-sector">所属行业：${d.sector}
          <span class="src-tag ${d.source === 'akshare' ? 'live' : 'sample'}">${d.source === 'akshare' ? '实时' : '样例'}</span>
        </div>
      </div>
      <div class="dh-right">
        <div class="d-price">
          <div class="d-px" style="color:${c}">${fmt(d.price)}</div>
          <div class="d-chg" style="color:${c}">${d.change_pct == null ? '—' : sign(d.change_pct) + fmt(d.change_pct) + '%'}</div>
        </div>
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
      <div class="panel-t">同业对比 · ${d.sector} <span class="sub">行业均值 PE ${fmt(sec.pe)} / PB ${fmt(sec.pb)}</span></div>
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
    series: [{ type: 'line', data, showSymbol: false, lineStyle: { width: 1.5, color: tc.accent }, areaStyle: { color: 'rgba(79,70,229,.08)' } }]
  });
}

/* ---------------- 板块表现（静态） ---------------- */
async function loadSectors() {
  try {
    const data = await api(STATIC_BASE + '/sectors.json');
    currentSectors = data;
    drawSectorBar(data);
    drawSectorTable(data);
    renderSectorNav(data);
  } catch (e) {
    $('sectorBar').innerHTML = '<div class="empty">板块数据加载失败</div>';
  }
}

function drawSectorBar(sectors) {
  const el = $('sectorBar');
  const tc = themeColors();
  const chart = charts.sector || (charts.sector = echarts.init(el));
  const sorted = [...sectors].sort((a, b) => (a.ret_60d || 0) - (b.ret_60d || 0));
  const names = sorted.map(s => s.name);
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps) => ps.map(p => `${p.name}<br/>${p.seriesName}: ${p.value == null ? '—' : (p.value >= 0 ? '+' : '') + p.value + '%'}`).join('') },
    legend: { data: ['近5日', '近20日', '近60日'], top: 0, textStyle: { color: tc.text } },
    grid: { left: 70, right: 24, top: 36, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { formatter: '{value}%', color: tc.text }, splitLine: { lineStyle: { color: tc.split } } },
    yAxis: { type: 'category', data: names, axisLabel: { color: tc.text, fontSize: 12 } },
    series: [
      { name: '近5日', type: 'bar', data: sorted.map(s => s.ret_5d), itemStyle: { color: (p) => p.value >= 0 ? tc.up : tc.down } },
      { name: '近20日', type: 'bar', data: sorted.map(s => s.ret_20d), itemStyle: { color: (p) => p.value >= 0 ? tc.up : tc.down } },
      { name: '近60日', type: 'bar', data: sorted.map(s => s.ret_60d), itemStyle: { color: (p) => p.value >= 0 ? tc.up : tc.down } }
    ]
  });
}

function drawSectorTable(sectors) {
  const rows = [...sectors].sort((a, b) => (b.ret_60d || 0) - (a.ret_60d || 0)).map(s => `<tr onclick="openSector('${s.name.replace(/'/g, "\\'")}')" style="cursor:pointer">
    <td>${s.name}</td>
    <td style="color:${s.ret_5d >= 0 ? UP : DOWN}">${s.ret_5d == null ? '—' : sign(s.ret_5d) + fmt(s.ret_5d) + '%'}</td>
    <td style="color:${s.ret_20d >= 0 ? UP : DOWN}">${s.ret_20d == null ? '—' : sign(s.ret_20d) + fmt(s.ret_20d) + '%'}</td>
    <td style="color:${s.ret_60d >= 0 ? UP : DOWN}">${s.ret_60d == null ? '—' : sign(s.ret_60d) + fmt(s.ret_60d) + '%'}</td>
  </tr>`).join('');
  $('sectorTable').innerHTML = `<thead><tr><th>板块</th><th>近5日</th><th>近20日</th><th>近60日</th></tr></thead><tbody>${rows}</tbody>`;
}

function scrollToSector(name) { openSector(name); }

async function openSector(name) {
  const box = $('sectorDetail');
  box.style.display = 'block';
  box.innerHTML = `<div class="panel"><div class="panel-t">${name} · 板块指数走势与成分股</div>
    <div id="secIdx" class="chart-sm"></div><div id="secCons"></div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        series: [{ type: 'line', data: sec.series.map(x => x.v), showSymbol: false, lineStyle: { width: 1.5, color: tc.accent }, areaStyle: { color: 'rgba(79,70,229,.08)' } }]
      });
    }
    const cons = await api(STATIC_BASE + '/sectors/' + encodeURIComponent(name) + '.json');
    const rows = cons.map(m => `<tr>
      <td><a class="lk" onclick="selectStock('${m.code}','${m.name}')">${m.name}</a> <span class="muted-cell">${m.code}</span></td>
      <td style="color:${m.ret60 >= 0 ? UP : DOWN}">${m.ret60 == null ? '—' : sign(m.ret60) + fmt(m.ret60) + '%'}</td>
      <td>${fmt(m.pe)}</td><td>${fmt(m.pb)}</td></tr>`).join('');
    $('secCons').innerHTML = `<table class="grid"><thead><tr><th>成分股</th><th>60日收益</th><th>PE</th><th>PB</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted-cell">无成分股数据</td></tr>'}</tbody></table>`;
  } catch (e) {
    $('secCons').innerHTML = '<div class="empty">加载失败</div>';
  }
}

/* ---------------- 主题切换时重绘图表 ---------------- */
function rerenderCharts() {
  if (currentDetail) { drawKline(currentDetail.ohlc || []); drawGauge(currentDetail.pe_percentile); drawPE(currentDetail.pe_history || []); }
  if (currentSectors) drawSectorBar(currentSectors);
}

/* ---------------- 工具 ---------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
window.addEventListener('resize', () => { Object.values(charts).forEach(c => c && c.resize()); });

init();
