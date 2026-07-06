# 股票投研看板 · 开源版 (Stock Research Dashboard)

> 面向**个人投资者**的 A 股投资研究辅助看板：输入任意股票即可直观查看其近期表现（K 线、均线、成交量、估值分位、同业对比），并一键纵览各板块近期表现。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Built with](https://img.shields.io/badge/Built%20with-Flask%20%2B%20ECharts-ff69b4.svg)](https://flask.palletsprojects.com/)

数据源自 [AkShare](https://akshare.akfamily.xyz/) 等公开接口，**未接入时自动回退内置样例，开箱即跑**；也可一键导出为纯静态站点，零后端托管。

> ⚠️ **风险提示**：本工具仅为研究辅助，所有内容仅供研究参考，**不构成任何投资建议**。市场有风险，投资需谨慎。

---

## 目录

- [✨ 功能特性](#功能特性)
- [🧱 技术架构](#技术架构)
- [🚀 快速开始](#快速开始)
  - [方式一：本地 Python 运行](#方式一本地-python-运行推荐开发)
  - [方式二：Docker 部署](#方式二docker-部署推荐)
  - [方式三：静态演示版（零后端）](#方式三静态演示版零后端)
- [⏰ 定时自动刷新](#定时自动刷新)
- [🐘 使用 PostgreSQL 持久化](#使用-postgresql-持久化)
- [🌐 生产环境对外公开](#生产环境对外公开)
- [🔄 数据更新与数据来源](#数据更新与数据来源)
- [📁 目录结构](#目录结构)
- [🤝 贡献](#贡献)
- [📜 开源协议](#开源协议)

---

## 功能特性

- **全市场检索**：覆盖全部 A 股（约 5500+ 只），按代码或名称模糊联想（基于内置种子文件，离线可用）。
- **个股近期表现**：K 线 + MA5/MA20 均线 + 成交量；市盈率 120 日历史；**估值分位温度计**（越低越便宜）。
- **同业对比**：个股 vs 行业均值 vs 全市场均值（PE/PB/ROE/60 日收益）。
- **板块表现**：主要行业板块的 5/20/60 日收益横向条形图，点击下钻看板块指数走势与成分股。
- **数据库持久化**：基于 SQLAlchemy，默认 SQLite（零配置），可通过 `DATABASE_URL` 切换到 PostgreSQL / TimescaleDB。
- **精致界面**：侧边栏 + 仪表盘布局，亮/暗双主题，响应式适配移动端，A 股「红涨绿跌」。
- **开源可部署**：Flask 服务 + Docker / docker-compose 一键部署；亦可导出为纯静态站点托管到任意静态平台（GitHub Pages / Netlify / CloudStudio 等），MIT 协议。

---

## 技术架构

```
                ┌───────────────── 数据源 (AkShare / 内置样例) ─────────────┐
                │  stock_info_a_code_name · board_industry · zh_a_hist ·     │
                │  valuation_baidu · board_industry_hist_em                  │
                └───────────────────────────┬──────────────────────────────┘
                                            │  build.py 写入
                                            ▼
                ┌───────────────────── 持久化层 (SQLAlchemy) ────────────────┐
                │  stock(全市场) · watchlist · sector(指数) ·                │
                │  sector_member(成分股) · stock_detail(详情缓存) · meta     │
                └───────────────────────────┬──────────────────────────────┘
                                            │  app.py (Flask) 读取 / 按需缓存
                                            ▼
                ┌───────────────────── 前端 (HTML/CSS/JS + ECharts) ─────────┐
                │  侧边栏(搜索/自选/板块) · 主区(个股详情/板块表现) · 双主题   │
                └───────────────────────────────────────────────────────────┘
```

**API 契约**

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/portfolio` | GET | 首屏快照：更新时间、数据源、市场均值、板块概览、自选股、首只详情 |
| `/api/search?q=` | GET | 全市场模糊搜索（代码/名称），返回前 30 条 |
| `/api/stock?code=&refresh=` | GET | 单只股票详情（按需实时拉取并缓存 6 小时；`refresh=1` 强制刷新） |
| `/api/sectors` | GET | 板块指数表现；构建中返回 `{loading:true}` |
| `/api/sector?name=` | GET | 板块下钻：成分股（PE/PB/60 日收益） |
| `/api/refresh?scope=` | POST/GET | 手动刷新数据库行情；`scope=watchlist\|sectors\|all`（默认 all），仅实时成功才覆盖旧数据 |
| `/api/refresh/status` | GET | 刷新状态：上次刷新时间、下次自动刷新时间、调度计划 |

---

## 快速开始

### 方式一：本地 Python 运行（推荐开发）

```bash
# 1. 准备环境（Python 3.10+）
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. 构建数据库（拉取全市场列表 + 板块 + 预热自选股，约 1~3 分钟）
python build.py

# 3. 启动服务
python app.py
# 打开 http://localhost:8011
```

> 未安装 `akshare` 或离线时，`build.py` 会自动回退到内置样例数据，界面照常可用。
> 端口可用环境变量覆盖：`PORT=9000 python app.py`。

### 方式二：Docker 部署（推荐）

```bash
# 构建并启动（首次启动会自动 build 数据库，约 1~3 分钟）
docker compose up -d --build

# 打开 http://localhost:8011
```

数据库文件持久化在 `./data/app.db`（已挂载卷，重建容器数据不丢）。

### 方式三：静态演示版（零后端）

适合做开源演示 / 静态托管（GitHub Pages、Netlify、CloudStudio 等），**无需后端、无定时刷新**，数据为构建快照：

```bash
# 1. 先确保数据库已构建（python build.py）
# 2. 导出为纯静态文件到 static-site/data-static/
python export_static.py

# 3. 用任意静态服务器托管 static-site/ 目录
cd static-site
python -m http.server 8080
# 打开 http://localhost:8080
```

静态版包含：全市场 5527 只搜索列表、16 个板块表现、约 30 只预生成个股详情（真实优先、缺失用样例），以及板块下钻。
`static-site/` 下的前端代码（`index.html` / `app.js` / `styles.css` / `echarts.min.js`）纳入版本控制；
`static-site/data-static/` 为生成物，已在 `.gitignore` 中排除。

---

## 定时自动刷新

服务内置 **APScheduler** 定时任务，默认在 **每日 18:30**（A 股收盘后）自动更新数据库：

- **个股详情**：刷新自选股 + 用户已查看过的个股（仅当实时拉取成功才写入，实时失败则保留原有数据，绝不把真实数据回退成样例）。
- **板块指数**：重新拉取各板块指数表现。

可用环境变量调整时间：

```bash
REFRESH_HOUR=18 REFRESH_MINUTE=30 python app.py
```

手动触发（UI 顶栏「↻ 刷新行情」按钮，或外部 cron）：

```bash
curl -X POST "http://localhost:8011/api/refresh?scope=all"
# scope 可选：watchlist（仅自选股）| sectors（仅板块）| all
```

> 说明：定时任务随 `python app.py` 主进程启动（单进程）。Docker 部署使用 **单 worker**（`gunicorn -w 1`）
> 以避免 APScheduler 在多 worker 下重复触发；若需用 gunicorn 多 worker，请用系统 cron 调用 `/api/refresh` 接口代替内置调度器。

---

## 使用 PostgreSQL 持久化

```bash
# 1. 取消 docker-compose.yml 中 db 服务与 web 的 DATABASE_URL 注释
# 2. 启动（含 Postgres）
docker compose up -d --build
```

或任意环境设置环境变量（应用会自动建表）：

```bash
export DATABASE_URL="postgresql+psycopg2://user:pass@localhost:5432/stockdb"
python build.py && python app.py
```

---

## 生产环境对外公开

把网站分享给别人 / 公开访问，有两条路径，按需选择。

### 路径 A：最快分享（IP + 端口直连）

适合临时/小范围分享，不绑定域名：

1. 找一台**有公网 IP** 的机器（云主机或任意 VPS），安装 Docker。
2. 把整个仓库目录传上去，运行：

   ```bash
   docker compose up -d --build
   ```

3. 在云主机**安全组 / 防火墙放行 TCP 8011**（入站允许 `0.0.0.0/0:8011`）。
4. 浏览器访问 `http://你的公网IP:8011` 即可。

> 该端口直接由 Flask 提供，未加密（HTTP）。仅建议内部分享或临时演示使用。

### 路径 B：正式公开（域名 + HTTPS，推荐）

`deploy/` 已提供 nginx 反向代理 + Let's Encrypt 自动证书配置，对外访问 `https://你的域名`，浏览器显示安全锁。

**前置条件**：一台有公网 IP 的云主机 + 一个已解析到该 IP 的域名（A 记录）。

```bash
cd deploy
cp nginx.http.conf nginx.conf        # 阶段一：先 HTTP（用于申请证书）
docker compose -f docker-compose.prod.yml up -d --build

# 申请免费 SSL 证书（把 YOUR_DOMAIN 换成你的真实域名）
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path /var/www/certbot -d YOUR_DOMAIN

cp nginx.https.conf nginx.conf        # 阶段二：启用 HTTPS
docker compose -f docker-compose.prod.yml restart nginx
# 访问 https://YOUR_DOMAIN
```

**关键检查清单**
- 云主机安全组放行 **80、443** 端口（HTTPS 申请与挑战必须）。
- `nginx.https.conf` 与 `nginx.conf` 中的 `YOUR_DOMAIN` 必须替换成真实域名，需替换 **3 处**（两处 `server_name` + 证书路径）。
- 数据库 `data/app.db` 已通过 `volumes` 挂载持久化，重建容器数据不丢。
- 定时刷新仍由 web 容器的 APScheduler 负责（单 worker，每日 18:30）。

---

## 数据更新与数据来源

- **搜索列表（全市场）**：优先读取仓库内置种子文件 `data/a_stocks.json`（已含全部 A 股代码与名称，约 5500+ 只），保证开源部署后搜索始终覆盖全市场、**不依赖外网**。AkShare 仅在刷新时尝试覆盖该文件。
- **板块与个股详情**：通过 AkShare 实时拉取（K 线、估值、成分股）。上游接口偶发限流/断连时，系统自动回退内置样例数据，**界面永不崩溃**；网络恢复后下次请求即回到实时数据。
- **个股详情**：按需实时拉取，结果缓存 6 小时（`stock_detail` 表）。
- **板块指数 / 全市场列表**：执行 `python build.py`（幂等，可重复运行；首次构建板块约 1 分钟）。

> 若需 100% 实时数据，请在能正常访问 Eastmoney / 交易所行情的网络环境下运行 `python build.py` 并访问站点。

---

## 目录结构

```
.
├── app.py              # Flask Web 服务（读取数据库 + 按需缓存 + 定时刷新）
├── build.py            # 数据构建脚本（写入数据库；幂等）
├── db.py               # SQLAlchemy 持久化层（SQLite / PostgreSQL）
├── datasrc.py          # 数据源模块（AkShare / 样例，统一 dict 结构，三级回退）
├── export_static.py    # 把数据库导出为纯静态 JSON（用于 static-site/）
├── index.html          # 前端页面（Flask 版）
├── app.js              # 前端逻辑（搜索 / 个股 / 板块 / 主题）
├── styles.css          # 前端样式（双主题）
├── echarts.min.js      # 本地图表库
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── deploy/             # 生产环境对外公开配置（nginx + certbot）
│   ├── docker-compose.prod.yml
│   ├── nginx.http.conf
│   └── nginx.https.conf
├── static-site/        # 纯静态演示版（零后端）
│   ├── index.html / app.js / styles.css / echarts.min.js
│   └── data-static/    # 生成物（gitignore，由 export_static.py 产出）
├── data/
│   └── a_stocks.json   # 全市场种子文件（纳入版本控制）
├── LICENSE             # MIT
├── CONTRIBUTING.md
└── README.md
```

---

## 贡献

欢迎 Issue 与 PR！请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 开源协议

[ MIT ](./LICENSE) — 可自由用于学习、研究与商业，请保留版权与免责声明。
