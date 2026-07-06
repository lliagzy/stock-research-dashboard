"""
把数据库内容导出为纯静态 JSON（用于 CloudStudio / 任意静态托管部署）。
生成目录： static-site/data-static/
  - portfolio.json      首屏快照（市场均值、板块概览、自选股、首只详情）
  - stocks.json         全市场搜索列表（5527 只，code/name/sector）
  - sectors.json        板块指数表现
  - stocks/<code>.json  预生成的个股详情（自选 + 热门龙头；真实优先，缺失用样例）
  - sectors/<name>.json 板块下钻（成分股 PE/PB/60日收益）
该静态版不含实时拉取与定时刷新，数据为构建快照，仅用于开源演示。
"""
import os
import shutil
import json
import datetime
import urllib.parse
from sqlalchemy import text

import db
import datasrc as ds

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "static-site", "data-static")
STOCKS_DIR = os.path.join(OUT, "stocks")
SECTORS_DIR = os.path.join(OUT, "sectors")
if os.path.exists(OUT):
    shutil.rmtree(OUT)   # 清空旧文件，避免编码/中文名残留混用
os.makedirs(STOCKS_DIR, exist_ok=True)
os.makedirs(SECTORS_DIR, exist_ok=True)


def main():
    db.init_db()
    name_by_code = {s["code"]: s["name"] for s in db.load_stocks()}
    sector_map = db.load_sector_map()

    # 1) 全市场搜索列表
    stocks = db.load_stocks()
    json.dump({"source": db.get_meta("data_source", "sample"), "stocks": stocks},
              open(os.path.join(OUT, "stocks.json"), "w", encoding="utf-8"),
              ensure_ascii=False)

    # 2) 板块表现
    sectors = db.load_sectors()
    json.dump(sectors, open(os.path.join(OUT, "sectors.json"), "w", encoding="utf-8"),
              ensure_ascii=False)

    # 3) 个股详情：优先用数据库缓存（真实），缺失则快速生成样例（不联网，保证演示覆盖）
    WATCH = ["600519", "300750", "600036", "002594", "601318",
             "002415", "600276", "000858", "000333", "601012"]
    HOT = ["600900", "601088", "600048", "601899", "002371", "688981", "603501",
           "300124", "000725", "600690", "600887", "603259", "300760", "601766",
           "600019", "601857", "000001", "600030", "601166", "000651"]
    PREGEN = list(dict.fromkeys(WATCH + HOT))  # 去重保序，约 30 只

    def get_detail(code):
        cached = db.load_stock_detail(code)
        if cached:
            return cached
        nm = name_by_code.get(code, code)
        # ak=None -> 直接走样例分支，不联网、秒级，保证演示版有数据
        return ds.get_stock_detail(None, code, nm, sector_map)

    watchlist = []
    featured = None
    for code in PREGEN:
        try:
            d = get_detail(code)
        except Exception:
            continue
        if not d:
            continue
        nm = d.get("name") or name_by_code.get(code, code)
        watchlist.append({
            "code": code, "name": nm,
            "price": d.get("price"), "pe_ttm": d.get("pe_ttm"),
            "pb": d.get("pb"), "ret60": d.get("ret_60d"), "sector": d.get("sector"),
        })
        json.dump(d, open(os.path.join(STOCKS_DIR, code + ".json"), "w", encoding="utf-8"),
                  ensure_ascii=False)
        if featured is None:
            featured = d

    # 4) 市场均值（从板块成分股 PE/PB 聚合，作为快照估值中枢）
    with db.engine.connect() as c:
        rows = c.execute(text("SELECT pe, pb FROM sector_member")).fetchall()
    pes = [r[0] for r in rows if r[0]]
    pbs = [r[1] for r in rows if r[1]]
    market = {
        "pe": round(sum(pes) / len(pes), 1) if pes else None,
        "pb": round(sum(pbs) / len(pbs), 2) if pbs else None,
        "roe": None,
        "source": "snapshot",
    }

    portfolio = {
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "data_source": db.get_meta("data_source", "sample"),
        "market": market,
        "sectors_meta": [{"name": s["name"], "ret_5d": s["ret_5d"],
                          "ret_20d": s["ret_20d"], "ret_60d": s["ret_60d"]} for s in sectors],
        "watchlist": watchlist,
        "featured": featured,
        "static": True,  # 标记：纯静态演示版
    }
    json.dump(portfolio, open(os.path.join(OUT, "portfolio.json"), "w", encoding="utf-8"),
              ensure_ascii=False)

    # 5) 板块下钻
    for s in sectors:
        name = s["name"]
        members = sector_map.get(name, [])
        rows = []
        for m in members[:20]:
            code = m["code"]
            det = db.load_stock_detail(code)
            rows.append({
                "code": code,
                "name": name_by_code.get(code, code),
                "pe": m.get("pe"), "pb": m.get("pb"),
                "ret60": det.get("ret_60d") if det else None,
            })
        fn = os.path.join(SECTORS_DIR, name + ".json")
        json.dump(rows, open(fn, "w", encoding="utf-8"), ensure_ascii=False)

    print("导出完成 ->", OUT)
    print("  stocks(搜索):", len(stocks))
    print("  sectors:", len(sectors))
    print("  watchlist(首屏自选):", len(watchlist))
    print("  stock_detail 文件:", len(os.listdir(STOCKS_DIR)))
    print("  sector 下钻文件:", len(os.listdir(SECTORS_DIR)))


if __name__ == "__main__":
    main()
