"""
数据构建脚本：把数据源写入数据库
=================================
用法：
    python build.py            # 完整构建（搜索列表 + 板块映射 + 板块指数 + 预热自选股）
    python build.py --stocks   # 仅构建全市场搜索列表
    python build.py --sectors  # 仅构建板块指数表现
说明：
- 优先使用 AkShare 实时数据；若未安装/网络失败，自动回退内置样例。
- 可重复执行，幂等（先清空再写入对应表）。
- 设置环境变量 DATABASE_URL 可切换到 PostgreSQL 等数据库。
"""

import os
import sys
import time
import argparse
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import db
import datasrc as ds


def build_stocks(ak):
    print("[1/3] 构建全市场搜索列表 ...")
    t0 = time.time()
    stocks, src = ds.build_search_list(ak)
    db.upsert_stocks(stocks)
    db.set_meta("data_source", src)
    print(f"      -> {len(stocks)} 只股票 (source={src}, 耗时 {time.time()-t0:.1f}s)")


def build_sector_map(ak):
    print("[2/3] 构建板块映射（成分股 + PE/PB）...")
    t0 = time.time()
    sector_map, board_names = ds.build_sector_map(ak)
    db.save_sector_members(sector_map)
    db.set_meta("board_names", ",".join(board_names))
    print(f"      -> {len(sector_map)} 个板块, {sum(len(v) for v in sector_map.values())} 只成分股 (耗时 {time.time()-t0:.1f}s)")
    return sector_map


def build_sectors(ak, sector_map):
    print("[3/3] 构建板块指数表现 ...")
    t0 = time.time()
    board_names = list(sector_map.keys())
    sectors = ds.build_sectors(ak, board_names)
    db.save_sectors(sectors)
    print(f"      -> {len(sectors)} 个板块指数 (耗时 {time.time()-t0:.1f}s)")


def warm_watchlist(ak, sector_map):
    """预热自选股详情缓存，保证首屏秒开。"""
    print("[预热] 缓存自选股详情 ...")
    t0 = time.time()
    hist_cache = {}
    for code in ds.WATCHLIST:
        # 先从 DB 取名称
        s = db.Session()
        try:
            row = s.get(db.Stock, code)
            name = row.name if row else code
        finally:
            s.close()
        detail = ds.get_stock_detail(ak, code, name, sector_map, hist_cache)
        db.save_stock_detail(code, detail)
    print(f"      -> {len(ds.WATCHLIST)} 只已缓存 (耗时 {time.time()-t0:.1f}s)")


def main():
    parser = argparse.ArgumentParser(description="构建股票投研数据库")
    parser.add_argument("--stocks", action="store_true", help="仅构建搜索列表")
    parser.add_argument("--sectors", action="store_true", help="仅构建板块指数")
    args = parser.parse_args()

    db.init_db()
    ak = ds.ak_mod()

    if args.stocks:
        build_stocks(ak)
    elif args.sectors:
        sector_map = db.load_sector_map()
        if not sector_map:
            print("板块映射为空，先构建板块映射 ...")
            sector_map = build_sector_map(ak)
        build_sectors(ak, sector_map)
    else:
        build_stocks(ak)
        sector_map = build_sector_map(ak)
        build_sectors(ak, sector_map)
        warm_watchlist(ak, sector_map)

    db.set_meta("updated_at", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))
    print("构建完成。")


if __name__ == "__main__":
    main()
