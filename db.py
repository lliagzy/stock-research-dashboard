"""
持久化层（SQLAlchemy）
=================================
- 默认使用 SQLite（零配置，开箱即跑，最适合开源部署）。
- 设置环境变量 DATABASE_URL 即可切换到 PostgreSQL / TimescaleDB，例如：
      DATABASE_URL=postgresql+psycopg2://user:pass@localhost:5432/stockdb
- 所有数据通过 ORM 存取，上层无需关心底层数据库类型。
约定：A 股 红涨绿跌（由前端处理）。
"""

import os
import json
import datetime

from sqlalchemy import (
    create_engine, Column, String, Float, Integer, Text, DateTime,
)
from sqlalchemy.orm import declarative_base, sessionmaker, scoped_session

HERE = os.path.dirname(os.path.abspath(__file__))

# 默认 SQLite 文件，放在 data/ 目录下（便于 Docker 挂载持久化）
DATA_DIR = os.path.join(HERE, "data")
DEFAULT_DB = os.path.join(DATA_DIR, "app.db")


def get_engine():
    url = os.environ.get("DATABASE_URL") or ("sqlite:///" + DEFAULT_DB)
    kwargs = {}
    if url.startswith("sqlite"):
        # SQLite 在多线程（Flask/gunicorn）下需要关闭单线程检查
        kwargs["connect_args"] = {"check_same_thread": False}
    # pool_pre_ping 让 Postgres 连接自动重连
    kwargs["pool_pre_ping"] = True
    return create_engine(url, **kwargs)


Base = declarative_base()
engine = get_engine()
Session = scoped_session(sessionmaker(bind=engine, autoflush=False))


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------
class Stock(Base):
    """全市场股票列表（代码/名称/行业）"""
    __tablename__ = "stock"
    code = Column(String(8), primary_key=True)
    name = Column(String(64), index=True)
    sector = Column(String(32), default="其他", index=True)


class Watchlist(Base):
    """自选股（首屏展示 + 预热缓存）"""
    __tablename__ = "watchlist"
    id = Column(Integer, primary_key=True)
    code = Column(String(8), index=True)


class Sector(Base):
    """行业板块指数表现（含归一化走势序列）"""
    __tablename__ = "sector"
    name = Column(String(32), primary_key=True)
    ret_5d = Column(Float)
    ret_20d = Column(Float)
    ret_60d = Column(Float)
    series_json = Column(Text)        # JSON: [{"d": "...", "v": 100.0}, ...]
    updated_at = Column(DateTime)


class SectorMember(Base):
    """行业板块成分股（用于行业归属、同业对比、板块下钻）"""
    __tablename__ = "sector_member"
    id = Column(Integer, primary_key=True)
    sector = Column(String(32), index=True)
    code = Column(String(8), index=True)
    pe = Column(Float)
    pb = Column(Float)


class StockDetail(Base):
    """个股详情缓存（按需拉取后落库，避免重复联网）"""
    __tablename__ = "stock_detail"
    code = Column(String(8), primary_key=True)
    payload = Column(Text)            # JSON: 完整 detail 字典
    updated_at = Column(DateTime)


class Meta(Base):
    """键值元数据（数据源、更新时间等）"""
    __tablename__ = "meta"
    key = Column(String(32), primary_key=True)
    value = Column(Text)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    Base.metadata.create_all(engine)


def get_session():
    return Session()


def set_meta(key, value):
    s = Session()
    try:
        row = s.get(Meta, key)
        if row is None:
            row = Meta(key=key, value=value)
            s.add(row)
        else:
            row.value = value
        s.commit()
    finally:
        s.close()


def get_meta(key, default=None):
    s = Session()
    try:
        row = s.get(Meta, key)
        return row.value if row else default
    finally:
        s.close()


def get_stock_count():
    s = Session()
    try:
        return s.query(Stock).count()
    finally:
        s.close()


def get_sector_count():
    s = Session()
    try:
        return s.query(Sector).count()
    finally:
        s.close()


def save_stock_detail(code, payload, ttl_hours=6):
    """写入/更新个股详情缓存。ttl_hours 仅用于记录时效，读取侧判断。"""
    s = Session()
    try:
        now = datetime.datetime.now()
        row = s.get(StockDetail, code)
        if row is None:
            row = StockDetail(code=code, payload=json.dumps(payload, ensure_ascii=False), updated_at=now)
            s.add(row)
        else:
            row.payload = json.dumps(payload, ensure_ascii=False)
            row.updated_at = now
        s.commit()
    finally:
        s.close()


def load_stock_detail(code, max_age_hours=6):
    """读取个股详情缓存；超过时效或不存在返回 None。"""
    s = Session()
    try:
        row = s.get(StockDetail, code)
        if row is None:
            return None
        age = (datetime.datetime.now() - row.updated_at).total_seconds() / 3600
        if age > max_age_hours:
            return None
        return json.loads(row.payload)
    finally:
        s.close()


def save_sectors(sectors):
    s = Session()
    try:
        now = datetime.datetime.now()
        # 先清空旧板块（板块集合可能随数据源变化）
        s.query(Sector).delete()
        for sec in sectors:
            s.add(Sector(
                name=sec["name"],
                ret_5d=sec.get("ret_5d"),
                ret_20d=sec.get("ret_20d"),
                ret_60d=sec.get("ret_60d"),
                series_json=json.dumps(sec.get("series", []), ensure_ascii=False),
                updated_at=now,
            ))
        s.commit()
    finally:
        s.close()


def load_sectors():
    s = Session()
    try:
        rows = s.query(Sector).all()
        out = []
        for r in rows:
            out.append({
                "name": r.name,
                "ret_5d": r.ret_5d,
                "ret_20d": r.ret_20d,
                "ret_60d": r.ret_60d,
                "series": json.loads(r.series_json) if r.series_json else [],
            })
        return out
    finally:
        s.close()


def save_sector_members(sector_map):
    """sector_map: {板块名: [{code,name,pe,pb}, ...]}"""
    s = Session()
    try:
        s.query(SectorMember).delete()
        for sector, members in sector_map.items():
            for m in members:
                s.add(SectorMember(
                    sector=sector, code=m["code"],
                    pe=m.get("pe"), pb=m.get("pb"),
                ))
        s.commit()
    finally:
        s.close()


def load_sector_map():
    s = Session()
    try:
        rows = s.query(SectorMember).all()
        mp = {}
        for r in rows:
            mp.setdefault(r.sector, []).append({"code": r.code, "pe": r.pe, "pb": r.pb})
        return mp
    finally:
        s.close()


def upsert_stocks(stocks):
    """批量写入股票列表（code/name/sector）。"""
    s = Session()
    try:
        for st in stocks:
            row = s.get(Stock, st["code"])
            sector = st.get("sector") or "其他"
            if row is None:
                s.add(Stock(code=st["code"], name=st["name"], sector=sector))
            else:
                row.name = st["name"]
                row.sector = sector
        s.commit()
    finally:
        s.close()


def load_stocks():
    s = Session()
    try:
        return [{"code": r.code, "name": r.name, "sector": r.sector} for r in s.query(Stock).all()]
    finally:
        s.close()
