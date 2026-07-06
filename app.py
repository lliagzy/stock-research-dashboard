"""
Web 服务（Flask）
=================================
- 所有数据从数据库读取（见 db.py）；个股详情按需实时拉取并缓存到 stock_detail 表。
- 启动期：若数据库为空，自动构建搜索列表 + 板块映射（同步，约 20~30s）；
  板块指数表现放后台线程构建（约 1 分钟），期间 /api/sectors 返回 {loading:true}。
- 设置环境变量 DATABASE_URL 可切换到 PostgreSQL；PORT 可改端口。
API 契约（与前端一致）：
  GET /api/portfolio -> {updated_at, data_source, market, sectors_meta[], watchlist[], featured}
  GET /api/search?q= -> [{code,name,sector}]
  GET /api/stock?code=&refresh= -> detail
  GET /api/sectors -> {loading:true} | [{name,ret_5d,ret_20d,ret_60d,series[]}]
  GET /api/sector?name= -> [{code,name,ret60,price,pe,pb}]
"""

import os
import sys
import json
import time
import threading
import datetime

from flask import Flask, request, send_from_directory, Response

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import db
import datasrc as ds

PORT = int(os.environ.get("PORT", "8011"))

app = Flask(__name__, static_folder=None)

_ak = ds.ak_mod()
_sector_map = {}        # 板块名 -> [{code,name,pe,pb}]
_lock = threading.Lock()
_sectors_building = False


# ---------------------------------------------------------------------------
# 启动期数据准备
# ---------------------------------------------------------------------------
def sector_map_with_names():
    """板块映射补上股票名称（DB 的 sector_member 仅存 code/pe/pb）。"""
    sm = db.load_sector_map()
    names = {s["code"]: s["name"] for s in db.load_stocks()}
    for members in sm.values():
        for m in members:
            m["name"] = names.get(m["code"], m["code"])
    return sm


def ensure_built():
    global _sector_map
    db.init_db()
    # 1) 搜索列表
    if db.get_stock_count() == 0:
        print("[startup] 搜索列表为空，构建中 ...")
        stocks, src = ds.build_search_list(_ak)
        db.upsert_stocks(stocks)
        db.set_meta("data_source", src)
        print(f"[startup] 搜索列表 {len(stocks)} 只 (source={src})")
    # 2) 板块映射
    _sector_map = sector_map_with_names()
    if not _sector_map:
        print("[startup] 板块映射为空，构建中 ...")
        _sector_map, _ = ds.build_sector_map(_ak)
        db.save_sector_members(_sector_map)
        _sector_map = sector_map_with_names()
    # 3) 板块指数（后台）
    if db.get_sector_count() == 0:
        t = threading.Thread(target=build_sectors_bg, daemon=True)
        t.start()
    else:
        db.set_meta("sectors_ready", "1")


def build_sectors_bg():
    global _sectors_building
    with _lock:
        if _sectors_building:
            return
        _sectors_building = True
    try:
        sectors = ds.build_sectors(_ak, list(_sector_map.keys()))
        db.save_sectors(sectors)
        db.set_meta("sectors_ready", "1")
        print(f"[bg] 板块指数 {len(sectors)} 个已就绪")
    finally:
        with _lock:
            _sectors_building = False


# ---------------------------------------------------------------------------
# 定时刷新 / 调度（APScheduler）
# 每日在 REFRESH_HOUR:REFRESH_MINUTE（默认 18:30，A股收盘后）自动更新数据库：
#   - 自选股 + 用户已查看过的个股详情（仅当实时拉取成功才覆盖，避免回退成样例）
#   - 板块指数表现
# 另提供 /api/refresh 手动触发，供 UI 按钮或外部 cron 调用。
# ---------------------------------------------------------------------------
REFRESH_HOUR = int(os.environ.get("REFRESH_HOUR", "18"))
REFRESH_MINUTE = int(os.environ.get("REFRESH_MINUTE", "30"))

_scheduler = None
_refresh_running = False


def _name_by_code():
    return {st["code"]: st for st in db.load_stocks()}


def refresh_stock_details():
    """刷新自选股 + 已缓存个股的详情；仅成功(akshare)才写入，保留旧真实数据。"""
    nb = _name_by_code()
    codes = set(ds.WATCHLIST)
    # 把所有已缓存过的个股也纳入刷新（用户看过的保持新鲜）
    s = db.Session()
    try:
        for r in s.query(db.StockDetail.code).all():
            codes.add(r.code)
    finally:
        s.close()
    ok = skip = fail = 0
    for code in sorted(codes):
        meta = nb.get(code) or {"code": code, "name": code, "sector": "其他"}
        try:
            d = ds.get_stock_detail(_ak, code, meta["name"], _sector_map)
        except Exception:
            fail += 1
            continue
        if d.get("source") == "akshare":
            db.save_stock_detail(code, d)
            ok += 1
        else:
            skip += 1  # 实时失败，保留数据库里原有（可能是真实）数据
    return {"ok": ok, "skip": skip, "fail": fail}


def refresh_sectors():
    sectors = ds.build_sectors(_ak, list(_sector_map.keys()))
    if sectors:
        db.save_sectors(sectors)
        db.set_meta("sectors_ready", "1")
        return len(sectors)
    return 0


def run_daily_refresh(scope="all"):
    """执行一次刷新。scope: watchlist | sectors | all。返回结果摘要。"""
    global _refresh_running
    if _refresh_running:
        return {"status": "running"}
    _refresh_running = True
    try:
        summary = {"status": "done", "scope": scope}
        if scope in ("all", "watchlist"):
            summary["stocks"] = refresh_stock_details()
        if scope in ("all", "sectors"):
            n = refresh_sectors()
            summary["sectors"] = n
        db.set_meta("last_refresh", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))
        print(f"[refresh] 完成 scope={scope} -> {summary}")
        return summary
    except Exception as e:
        return {"status": "error", "message": str(e)[:200]}
    finally:
        _refresh_running = False


def start_scheduler():
    global _scheduler
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
    except Exception as e:
        print(f"[scheduler] 未安装 apscheduler，跳过定时任务（可 pip install apscheduler）: {e}")
        return
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        lambda: run_daily_refresh("all"),
        trigger=CronTrigger(hour=REFRESH_HOUR, minute=REFRESH_MINUTE),
        id="daily_refresh", replace_existing=True,
        misfire_grace_time=3600,
    )
    _scheduler.start()
    print(f"[scheduler] 已启用每日 {REFRESH_HOUR:02d}:{REFRESH_MINUTE:02d} 自动刷新数据库行情")


def next_refresh_time():
    """粗略估算下一次自动刷新时间（本地时区），用于前端展示。"""
    now = datetime.datetime.now()
    nxt = now.replace(hour=REFRESH_HOUR, minute=REFRESH_MINUTE, second=0, microsecond=0)
    if nxt <= now:
        nxt += datetime.timedelta(days=1)
    return nxt.strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------------------
# 数据访问
# ---------------------------------------------------------------------------
def get_stock_detail_cached(code, name, refresh=False):
    if not refresh:
        cached = db.load_stock_detail(code, max_age_hours=6)
        if cached:
            return cached
    detail = ds.get_stock_detail(_ak, code, name, _sector_map)
    db.save_stock_detail(code, detail)
    return detail


def build_portfolio():
    src = db.get_meta("data_source", "sample")
    updated = db.get_meta("updated_at", "—")
    sector_map = db.load_sector_map()
    market = ds.market_averages(sector_map) if sector_map else {"avg_pe": None, "avg_pb": None, "avg_roe": None}

    # 自选股
    s = db.Session()
    try:
        wl_rows = s.query(db.Watchlist).all()
        wl_codes = [r.code for r in wl_rows]
    finally:
        s.close()
    if not wl_codes:
        wl_codes = ds.WATCHLIST

    name_by_code = {st["code"]: st for st in db.load_stocks()}
    watchlist = []
    featured_detail = None
    for code in wl_codes:
        meta = name_by_code.get(code) or {"code": code, "name": code, "sector": "其他"}
        detail = db.load_stock_detail(code, max_age_hours=6) or get_stock_detail_cached(code, meta["name"])
        watchlist.append({
            "code": code, "name": meta["name"], "sector": meta["sector"],
            "price": detail.get("price"), "change_pct": detail.get("change_pct"),
            "pe_ttm": detail.get("pe_ttm"), "pb": detail.get("pb"),
        })
        if featured_detail is None:
            featured_detail = detail

    sectors = db.load_sectors()
    sectors_meta = [{"name": x["name"], "ret_5d": x.get("ret_5d"),
                     "ret_20d": x.get("ret_20d"), "ret_60d": x.get("ret_60d")} for x in sectors]

    return {
        "updated_at": updated,
        "data_source": src,
        "market": market,
        "sectors_meta": sectors_meta,
        "watchlist": watchlist,
        "featured": featured_detail,
        "last_refresh": db.get_meta("last_refresh", "—"),
        "next_refresh": next_refresh_time(),
        "refresh_schedule": f"{REFRESH_HOUR:02d}:{REFRESH_MINUTE:02d} 每日",
    }


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/app.js")
def app_js():
    return send_from_directory(HERE, "app.js", mimetype="application/javascript; charset=utf-8")


@app.route("/styles.css")
def styles_css():
    return send_from_directory(HERE, "styles.css", mimetype="text/css; charset=utf-8")


@app.route("/echarts.min.js")
def echarts_js():
    return send_from_directory(HERE, "echarts.min.js", mimetype="application/javascript; charset=utf-8")


def _json(payload):
    return Response(json.dumps(payload, ensure_ascii=False), mimetype="application/json; charset=utf-8")


@app.route("/api/portfolio")
def api_portfolio():
    return _json(build_portfolio())


@app.route("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip().lower()
    stocks = db.load_stocks()
    # 从板块映射反查行业，给搜索结果标注真实行业
    code2sector = {}
    for sec, members in _sector_map.items():
        for m in members:
            code2sector.setdefault(m["code"], sec)
    if not q:
        return _json([])
    out = []
    for st in stocks:
        if st["code"] == q or st["code"].startswith(q) or q in st["name"].lower():
            st = dict(st)
            st["sector"] = code2sector.get(st["code"], st.get("sector") or "其他")
            out.append(st)
        if len(out) >= 30:
            break
    return _json(out)


@app.route("/api/stock")
def api_stock():
    code = (request.args.get("code") or "").strip()
    refresh = request.args.get("refresh") == "1"
    if not code:
        return _json({"error": "code required"}), 400
    meta = next((st for st in db.load_stocks() if st["code"] == code), None)
    name = meta["name"] if meta else code
    try:
        detail = get_stock_detail_cached(code, name, refresh=refresh)
    except Exception as e:
        return _json({"error": str(e)}), 500
    return _json(detail)


@app.route("/api/sectors")
def api_sectors():
    sectors = db.load_sectors()
    if not sectors:
        return _json({"loading": True, "hint": "板块指数数据构建中，请稍后刷新本页"})
    return _json(sectors)


@app.route("/api/sector")
def api_sector():
    name = (request.args.get("name") or "").strip()
    if not name:
        return _json([])
    members = sector_map_with_names().get(name, [])
    rows = ds.get_sector_constituents(_ak, name, {name: members})
    return _json(rows)


@app.route("/api/refresh", methods=["POST", "GET"])
def api_refresh():
    """手动触发刷新。?scope=watchlist|sectors|all（默认 all）。"""
    scope = (request.args.get("scope") or "all").lower()
    if scope not in ("watchlist", "sectors", "all"):
        scope = "all"
    summary = run_daily_refresh(scope)
    return _json(summary)


@app.route("/api/refresh/status")
def api_refresh_status():
    return _json({
        "last_refresh": db.get_meta("last_refresh", "—"),
        "next_refresh": next_refresh_time(),
        "schedule": f"{REFRESH_HOUR:02d}:{REFRESH_MINUTE:02d} 每日",
        "scheduler_on": _scheduler is not None,
    })


if __name__ == "__main__":
    ensure_built()
    start_scheduler()
    print(f"serving on http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
