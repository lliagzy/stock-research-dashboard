"""
数据源模块（纯函数，不接触存储）
=================================
把 AkShare 实时数据与内置样例数据统一成相同的 dict 结构，供 build.py / app.py 使用。
- build_search_list：全 A 股票（约 5500+ 只），失败回退内置样例。
- build_sector_map：精选主要行业的成分股（含 PE/PB）。
- build_sectors：板块指数历史表现。
- get_stock_detail：单只股票详情（K线 + 估值 + 同业），按需实时拉取。
- get_sector_constituents：板块下钻成分股（含 60 日收益）。
约定：A 股 红涨绿跌（前端处理）。
"""

import os
import json
import random
import datetime

# 精选主要行业（按关键词匹配 AkShare 真实行业板块名称，失败自动跳过）
CURATED_SECTORS = [
    "银行", "证券", "保险", "食品饮料", "白酒", "医药生物", "半导体",
    "汽车", "电力设备", "电池", "计算机", "消费电子", "房地产",
    "有色金属", "煤炭", "钢铁", "家用电器", "建筑材料", "机械设备",
]

# 首屏自选股（预热缓存，保证首屏秒开）
WATCHLIST = ["600519", "300750", "600036", "601318", "600276", "002415"]

SAMPLE_UNIVERSE = [
    {"code": "600519", "name": "贵州茅台", "sector": "食品饮料", "price": 1680.0, "pe": 28.5, "pb": 9.2, "roe": 30.1, "mcap": 211000, "rev": 1500, "np": 748, "gm": 91.2},
    {"code": "000858", "name": "五粮液", "sector": "食品饮料", "price": 145.0, "pe": 18.0, "pb": 4.1, "roe": 22.0, "mcap": 56000, "rev": 830, "np": 300, "gm": 75.0},
    {"code": "600887", "name": "伊利股份", "sector": "食品饮料", "price": 28.0, "pe": 16.0, "pb": 3.2, "roe": 18.0, "mcap": 18000, "rev": 1260, "np": 105, "gm": 33.0},
    {"code": "300750", "name": "宁德时代", "sector": "电力设备", "price": 235.0, "pe": 21.0, "pb": 4.1, "roe": 22.5, "mcap": 103000, "rev": 4050, "np": 450, "gm": 21.8},
    {"code": "002594", "name": "比亚迪", "sector": "电力设备", "price": 352.0, "pe": 22.5, "pb": 4.8, "roe": 20.0, "mcap": 102000, "rev": 7020, "np": 405, "gm": 20.2},
    {"code": "601012", "name": "隆基绿能", "sector": "电力设备", "price": 18.0, "pe": 12.0, "pb": 1.6, "roe": 12.0, "mcap": 13600, "rev": 1290, "np": 108, "gm": 18.0},
    {"code": "600036", "name": "招商银行", "sector": "银行", "price": 42.5, "pe": 7.2, "pb": 1.05, "roe": 16.2, "mcap": 107000, "rev": 3400, "np": 1480, "gm": None},
    {"code": "601398", "name": "工商银行", "sector": "银行", "price": 6.8, "pe": 6.0, "pb": 0.62, "roe": 11.0, "mcap": 240000, "rev": 8200, "np": 3650, "gm": None},
    {"code": "600000", "name": "浦发银行", "sector": "银行", "price": 9.5, "pe": 4.8, "pb": 0.45, "roe": 8.0, "mcap": 28000, "rev": 1700, "np": 420, "gm": None},
    {"code": "601318", "name": "中国平安", "sector": "保险", "price": 54.8, "pe": 9.1, "pb": 1.02, "roe": 12.3, "mcap": 99800, "rev": 9100, "np": 1130, "gm": None},
    {"code": "601628", "name": "中国人寿", "sector": "保险", "price": 38.0, "pe": 12.0, "pb": 1.8, "roe": 10.0, "mcap": 107000, "rev": 4300, "np": 680, "gm": None},
    {"code": "600276", "name": "恒瑞医药", "sector": "医药生物", "price": 48.0, "pe": 45.0, "pb": 6.5, "roe": 18.0, "mcap": 30600, "rev": 240, "np": 52, "gm": 85.0},
    {"code": "300760", "name": "迈瑞医疗", "sector": "医药生物", "price": 265.0, "pe": 28.0, "pb": 8.0, "roe": 30.0, "mcap": 32100, "rev": 360, "np": 115, "gm": 66.0},
    {"code": "688981", "name": "中芯国际", "sector": "半导体", "price": 58.0, "pe": 80.0, "pb": 3.2, "roe": 6.0, "mcap": 46000, "rev": 560, "np": 48, "gm": 22.0},
    {"code": "603501", "name": "韦尔股份", "sector": "半导体", "price": 110.0, "pe": 40.0, "pb": 5.0, "roe": 14.0, "mcap": 13400, "rev": 210, "np": 25, "gm": 30.0},
    {"code": "002415", "name": "海康威视", "sector": "半导体", "price": 32.0, "pe": 20.0, "pb": 4.0, "roe": 22.0, "mcap": 29600, "rev": 890, "np": 140, "gm": 44.0},
    {"code": "601633", "name": "长城汽车", "sector": "汽车", "price": 25.0, "pe": 14.0, "pb": 2.2, "roe": 13.0, "mcap": 21000, "rev": 1700, "np": 90, "gm": 19.0},
    {"code": "600104", "name": "上汽集团", "sector": "汽车", "price": 15.0, "pe": 8.0, "pb": 0.7, "roe": 9.0, "mcap": 17500, "rev": 7400, "np": 165, "gm": 10.0},
    {"code": "002230", "name": "科大讯飞", "sector": "计算机", "price": 48.0, "pe": 60.0, "pb": 4.5, "roe": 8.0, "mcap": 11100, "rev": 200, "np": 12, "gm": 40.0},
    {"code": "000725", "name": "京东方A", "sector": "计算机", "price": 4.2, "pe": 25.0, "pb": 1.1, "roe": 4.0, "mcap": 15600, "rev": 1900, "np": 25, "gm": 12.0},
    {"code": "601899", "name": "紫金矿业", "sector": "有色金属", "price": 17.0, "pe": 15.0, "pb": 3.0, "roe": 20.0, "mcap": 45000, "rev": 2900, "np": 300, "gm": 16.0},
    {"code": "600900", "name": "长江电力", "sector": "公用事业", "price": 28.0, "pe": 22.0, "pb": 3.2, "roe": 14.0, "mcap": 68000, "rev": 780, "np": 280, "gm": None},
    {"code": "000333", "name": "美的集团", "sector": "家用电器", "price": 75.0, "pe": 14.0, "pb": 2.8, "roe": 20.0, "mcap": 53000, "rev": 3700, "np": 340, "gm": 25.0},
    {"code": "600309", "name": "万华化学", "sector": "化工", "price": 82.0, "pe": 16.0, "pb": 3.0, "roe": 18.0, "mcap": 26000, "rev": 1750, "np": 170, "gm": 18.0},
    {"code": "601888", "name": "中国中免", "sector": "商贸零售", "price": 75.0, "pe": 22.0, "pb": 3.5, "roe": 16.0, "mcap": 15500, "rev": 680, "np": 70, "gm": 30.0},
    {"code": "600030", "name": "中信证券", "sector": "证券", "price": 26.0, "pe": 16.0, "pb": 1.3, "roe": 9.0, "mcap": 39000, "rev": 600, "np": 200, "gm": None},
    {"code": "000001", "name": "平安银行", "sector": "银行", "price": 11.0, "pe": 4.5, "pb": 0.5, "roe": 10.0, "mcap": 21000, "rev": 1500, "np": 460, "gm": None},
    {"code": "300059", "name": "东方财富", "sector": "证券", "price": 14.0, "pe": 25.0, "pb": 2.5, "roe": 10.0, "mcap": 22000, "rev": 110, "np": 80, "gm": None},
    {"code": "002475", "name": "立讯精密", "sector": "消费电子", "price": 38.0, "pe": 24.0, "pb": 5.0, "roe": 20.0, "mcap": 27000, "rev": 2300, "np": 110, "gm": 12.0},
    {"code": "600585", "name": "海螺水泥", "sector": "建筑材料", "price": 25.0, "pe": 9.0, "pb": 0.9, "roe": 10.0, "mcap": 13000, "rev": 1300, "np": 130, "gm": 28.0},
]


def last_n_trading_days(n, end=None):
    days = []
    d = end or datetime.date.today()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d -= datetime.timedelta(days=1)
    return list(reversed(days))


def gen_ohlc(end_price, n, seed, drift):
    rnd = random.Random(seed)
    closes = [end_price / ((1 + drift) ** (n - 1))]
    for _ in range(n - 1):
        step = drift + rnd.uniform(-0.022, 0.024)
        closes.append(closes[-1] * (1 + step))
    factor = end_price / closes[-1]
    closes = [c * factor for c in closes]
    out = []
    base_vol = rnd.randint(800_000, 4_000_000)
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * 0.99
        hi = max(o, c) * (1 + abs(rnd.uniform(0, 0.012)))
        lo = min(o, c) * (1 - abs(rnd.uniform(0, 0.012)))
        vol = int(base_vol * (1 + rnd.uniform(-0.3, 0.5)))
        out.append({"o": round(o, 2), "h": round(hi, 2), "l": round(lo, 2), "c": round(c, 2), "v": vol})
    return out


def gen_pe_history(pe, n=120, seed=1):
    rnd = random.Random(seed)
    return [round(pe * (1 + rnd.uniform(-0.3, 0.3)), 2) for _ in range(n)]


def _safe(x):
    try:
        v = float(x)
        if v != v:
            return None
        return v
    except Exception:
        return None


def ak_mod():
    try:
        import akshare as ak
        return ak
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 搜索列表（全市场）
# 优先级：本地种子文件(data/a_stocks.json) > AkShare > 内置样例。
# 说明：AkShare 的 stock_info_a_code_name 依赖 szse.cn，部分网络环境会 SSL 失败，
#       因此把曾成功拉取的全量列表固化为种子文件，保证开源部署后搜索始终覆盖全市场。
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_STOCKS = os.path.join(HERE, "data", "a_stocks.json")


def build_search_list(ak, local_path=None):
    local_path = local_path or LOCAL_STOCKS
    # 1) 本地种子文件优先（离线 / 部署即用）
    if os.path.exists(local_path):
        try:
            d = json.load(open(local_path, encoding="utf-8"))
            stocks = d.get("stocks", [])
            if stocks:
                return [{"code": s["code"], "name": s["name"], "sector": s.get("sector", "其他")} for s in stocks], d.get("source", "local")
        except Exception:
            pass
    # 2) AkShare 实时（可能失败）
    if ak is not None:
        try:
            df = ak.stock_info_a_code_name()
            out = []
            for _, row in df.iterrows():
                code = str(row["code"]).zfill(6)
                name = str(row["name"])
                out.append({"code": code, "name": name, "sector": "其他"})
            if out:
                # 回写种子文件，供后续稳定使用
                try:
                    json.dump({"source": "akshare", "stocks": out}, open(local_path, "w", encoding="utf-8"), ensure_ascii=False)
                except Exception:
                    pass
                return out, "akshare"
        except Exception:
            pass
    # 3) 内置样例兜底
    return [{"code": s["code"], "name": s["name"], "sector": s["sector"]} for s in SAMPLE_UNIVERSE], "sample"


# ---------------------------------------------------------------------------
# 板块映射：精选行业 -> 成分股(含 PE/PB)
# ---------------------------------------------------------------------------
def _resolve_board_names(ak, candidates):
    try:
        boards = ak.stock_board_industry_name_em()
        names = boards["板块名称"].tolist()
    except Exception:
        return candidates
    resolved = []
    for cand in candidates:
        if cand in names:
            resolved.append(cand)
        else:
            hit = [n for n in names if cand in n]
            if hit:
                hit.sort(key=lambda x: (x != cand, len(x)))
                resolved.append(hit[0])
    seen = set()
    out = []
    for n in resolved:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def build_sector_map(ak):
    if ak is None:
        return _sample_sector_map(), []
    try:
        board_names = _resolve_board_names(ak, CURATED_SECTORS)
        sector_map = {}
        for nm in board_names:
            try:
                cons = ak.stock_board_industry_cons_em(symbol=nm)
                members = []
                for _, r in cons.iterrows():
                    members.append({
                        "code": str(r["代码"]).zfill(6),
                        "name": str(r["名称"]),
                        "pe": _safe(r.get("市盈率-动态")),
                        "pb": _safe(r.get("市净率")),
                    })
                if members:
                    sector_map[nm] = members
            except Exception:
                continue
        if not sector_map:
            return _sample_sector_map(), []
        return sector_map, list(sector_map.keys())
    except Exception:
        return _sample_sector_map(), []


def _sample_sector_map():
    m = {}
    for s in SAMPLE_UNIVERSE:
        m.setdefault(s["sector"], []).append({"code": s["code"], "name": s["name"], "pe": s["pe"], "pb": s["pb"]})
    return m


def sector_of(code, sector_map):
    for sec, members in sector_map.items():
        if any(m["code"] == code for m in members):
            return sec
    return "其他"


def market_averages(sector_map):
    pes, pbs = [], []
    for members in sector_map.values():
        for m in members:
            if m.get("pe"):
                pes.append(m["pe"])
            if m.get("pb"):
                pbs.append(m["pb"])
    return {
        "avg_pe": round(sum(pes) / len(pes), 1) if pes else None,
        "avg_pb": round(sum(pbs) / len(pbs), 2) if pbs else None,
        "avg_roe": None,
    }


# ---------------------------------------------------------------------------
# 板块指数历史
# ---------------------------------------------------------------------------
def _sector_from_index(hist, name):
    if hist is None or len(hist) == 0:
        return None
    closes = [_safe(x) for x in hist["收盘"].tail(60).tolist()]
    dates = [str(x) for x in hist["日期"].tail(60).tolist()]
    closes = [c for c in closes if c is not None]
    if len(closes) < 6:
        return None
    base = closes[0]
    norm = [round(v / base * 100, 2) for v in closes]
    ret5 = round((norm[-1] / norm[-6] - 1) * 100, 2) if len(norm) >= 6 else None
    ret20 = round((norm[-1] / norm[-21] - 1) * 100, 2) if len(norm) >= 21 else None
    ret60 = round((norm[-1] / norm[0] - 1) * 100, 2)
    return {
        "name": name, "ret_5d": ret5, "ret_20d": ret20, "ret_60d": ret60,
        "series": [{"d": dates[i], "v": norm[i]} for i in range(len(dates))],
    }


def build_sectors(ak, board_names):
    if not board_names:
        return _sample_sectors_raw()
    out = []
    for nm in board_names:
        try:
            hist = ak.stock_board_industry_hist_em(symbol=nm, period="日k", adjust="")
            sec = _sector_from_index(hist, nm)
            if sec:
                out.append(sec)
        except Exception:
            continue
    if not out:
        return _sample_sectors_raw()
    out.sort(key=lambda x: (x["ret_20d"] is not None, x["ret_20d"] or 0), reverse=True)
    return out


def _sample_sectors_raw():
    dates = last_n_trading_days(60)
    by_code = {}
    for base in SAMPLE_UNIVERSE:
        ohlc = gen_ohlc(base["price"], len(dates), int(base["code"]), 0.0)
        by_code[base["code"]] = {"code": base["code"], "name": base["name"], "sector": base["sector"], "ohlc": ohlc}
    sectors = {}
    for s in by_code.values():
        sectors.setdefault(s["sector"], []).append(s)
    out = []
    for name, members in sectors.items():
        series = [sum(m["ohlc"][i]["c"] for m in members) / len(members) for i in range(len(dates))]
        base0 = series[0]
        norm = [round(v / base0 * 100, 2) for v in series]
        ret5 = round((norm[-1] / norm[-6] - 1) * 100, 2) if len(norm) >= 6 else None
        ret20 = round((norm[-1] / norm[-21] - 1) * 100, 2) if len(norm) >= 21 else None
        ret60 = round((norm[-1] / norm[0] - 1) * 100, 2)
        out.append({"name": name, "ret_5d": ret5, "ret_20d": ret20, "ret_60d": ret60,
                    "series": [{"d": dates[i], "v": norm[i]} for i in range(len(dates))]})
    out.sort(key=lambda x: (x["ret_20d"] is not None, x["ret_20d"] or 0), reverse=True)
    return out


# ---------------------------------------------------------------------------
# 个股详情（按需实时拉取）
# ---------------------------------------------------------------------------
def _sample_base(code, name, sector):
    b = next((s for s in SAMPLE_UNIVERSE if s["code"] == code), None)
    if b is None:
        b = {"code": code, "name": name, "sector": sector or "其他",
             "price": 20.0, "pe": 20.0, "pb": 2.0, "roe": 12.0, "mcap": 1000, "rev": 100, "np": 10, "gm": 30}
    return b


def _valuation_series(ak, code, indicator):
    try:
        df = ak.stock_zh_valuation_baidu(symbol=code, indicator=indicator, period="近一年")
        vals = [{"d": str(r["date"]), "v": _safe(r["value"])} for _, r in df.iterrows()]
        vals = [v for v in vals if v["v"] is not None]
        return vals
    except Exception:
        return []


def get_stock_detail(ak, code, name, sector_map, hist_cache=None, with_fundamentals=False):
    """返回单只股票的真实/样例详情。"""
    if ak is None:
        return _sample_detail(code, name, sector_map)
    try:
        end = datetime.date.today().strftime("%Y%m%d")
        hist = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq", end_date=end, timeout=10)
        if hist is None or len(hist) == 0:
            return _sample_detail(code, name, sector_map)
        h = hist.tail(60)
        dates = [str(x) for x in h["日期"].tolist()]
        ohlc = [{"d": dates[i], "o": _safe(h["开盘"].iloc[i]), "h": _safe(h["最高"].iloc[i]),
                 "l": _safe(h["最低"].iloc[i]), "c": _safe(h["收盘"].iloc[i]),
                 "v": int(_safe(h["成交量"].iloc[i]) or 0)} for i in range(len(h))]
        closes = [x["c"] for x in ohlc]
        price = closes[-1]
        change_pct = round((closes[-1] - closes[-2]) / closes[-2] * 100, 2) if len(closes) >= 2 else None

        pe_series = _valuation_series(ak, code, "市盈率(TTM)")[-120:]
        pb_series = _valuation_series(ak, code, "市净率")[-120:]
        cur_pe = pe_series[-1]["v"] if pe_series else None
        cur_pb = pb_series[-1]["v"] if pb_series else None
        pe_hist = [p["v"] for p in pe_series]
        if cur_pe and pe_hist:
            pe_pct = round(sum(1 for v in pe_hist if v <= cur_pe) / len(pe_hist) * 100, 1)
        else:
            pe_pct = None

        sector = sector_of(code, sector_map)
        peers, sec_avg = _peers_and_avg(ak, code, sector, sector_map, hist_cache)

        return {
            "code": code, "name": name, "sector": sector,
            "price": price, "change_pct": change_pct,
            "pe_ttm": cur_pe, "pb": cur_pb, "roe": None,
            "market_cap": None, "revenue_ttm": None, "net_profit_ttm": None, "gross_margin": None,
            "ohlc": ohlc, "pe_history": pe_hist, "pe_percentile": pe_pct,
            "peers": peers, "sector_avg": sec_avg,
            "source": "akshare",
        }
    except Exception:
        return _sample_detail(code, name, sector_map)


def _peers_and_avg(ak, code, sector, sector_map, hist_cache):
    members = sector_map.get(sector, [])
    if not members:
        return [], {"pe": None, "pb": None, "roe": None}
    pes = [m["pe"] for m in members if m.get("pe")]
    pbs = [m["pb"] for m in members if m.get("pb")]
    sec_avg = {"pe": round(sum(pes) / len(pes), 1) if pes else None,
               "pb": round(sum(pbs) / len(pbs), 2) if pbs else None, "roe": None}
    peers = []
    end = datetime.date.today().strftime("%Y%m%d")
    for m in members:
        if m["code"] == code:
            continue
        pe = m.get("pe")
        pb = m.get("pb")
        ret60 = None
        cache = hist_cache or {}
        if m["code"] in cache:
            ret60 = cache[m["code"]]
        elif ak is not None:
            try:
                ph = ak.stock_zh_a_hist(symbol=m["code"], period="daily", adjust="qfq", end_date=end, timeout=8).tail(60)
                if len(ph) >= 2:
                    ret60 = round((_safe(ph["收盘"].iloc[-1]) / _safe(ph["收盘"].iloc[0]) - 1) * 100, 2)
                    cache[m["code"]] = ret60
            except Exception:
                pass
        peers.append({"code": m["code"], "name": m.get("name", m["code"]), "ret60": ret60, "pe": pe, "pb": pb})
        if len(peers) >= 6:
            break
    return peers, sec_avg


def _sample_detail(code, name, sector_map):
    sector = sector_of(code, sector_map) if sector_map else None
    base = _sample_base(code, name, sector)
    dates = last_n_trading_days(60)
    seed = int(base["code"])
    ohlc = gen_ohlc(base["price"], len(dates), seed, 0.0)
    closes = [x["c"] for x in ohlc]
    change_pct = round((closes[-1] - closes[-2]) / closes[-2] * 100, 2)
    pe_hist = gen_pe_history(base["pe"], 120, seed + 1)
    pe_pct = round(sum(1 for v in pe_hist if v <= base["pe"]) / len(pe_hist) * 100, 1)
    if not sector:
        sector = base["sector"]
    peers, sec_avg = _peers_and_avg(None, code, sector, sector_map, None)
    return {
        "code": code, "name": name, "sector": sector,
        "price": base["price"], "change_pct": change_pct,
        "pe_ttm": base["pe"], "pb": base["pb"], "roe": base["roe"],
        "market_cap": base["mcap"], "revenue_ttm": base["rev"],
        "net_profit_ttm": base["np"], "gross_margin": base["gm"],
        "ohlc": [dict(d=dates[i], **ohlc[i]) for i in range(len(dates))],
        "pe_history": pe_hist, "pe_percentile": pe_pct,
        "peers": peers, "sector_avg": sec_avg,
        "source": "sample",
    }


def get_sector_constituents(ak, name, sector_map):
    """板块下钻：返回成分股(含 pe/pb/60日收益)，限前 20 只以保证点击响应。"""
    members = sector_map.get(name, [])
    if not members:
        return []
    members = members[:20]
    end = datetime.date.today().strftime("%Y%m%d")
    rows = []
    for m in members:
        ret60 = None
        if ak is not None:
            try:
                ph = ak.stock_zh_a_hist(symbol=m["code"], period="daily", adjust="qfq", end_date=end, timeout=8).tail(60)
                if len(ph) >= 2:
                    ret60 = round((_safe(ph["收盘"].iloc[-1]) / _safe(ph["收盘"].iloc[0]) - 1) * 100, 2)
            except Exception:
                pass
        rows.append({"code": m["code"], "name": m.get("name", m["code"]), "ret60": ret60,
                     "price": None, "pe": m.get("pe"), "pb": m.get("pb")})
    rows.sort(key=lambda x: (x["ret60"] is not None, x["ret60"] or 0), reverse=True)
    return rows
