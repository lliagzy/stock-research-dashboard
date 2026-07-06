# 贡献指南 (Contributing)

感谢你考虑为「股票投研看板」做贡献！本项目是一个面向个人投资者的开源研究辅助工具，欢迎 Issue、建议与 PR。

## 开发环境

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python build.py      # 构建数据库（无 AkShare 时自动回退内置样例）
python app.py        # 启动 http://localhost:8011
```

## 分支与提交

- 主分支为 `main`，请基于 `main` 创建特性分支（`feat/xxx`、`fix/xxx`）。
- 提交信息建议清晰描述意图，例如：`fix: 板块下钻中文文件名双重编码`、`feat: 增加港股搜索`。
- 保持 PR 聚焦单一改动，便于 review。

## 代码约定

- 后端 Python：遵循 PEP 8；数据访问统一走 `db.py`，新增数据源接口放在 `datasrc.py`（保持 AkShare / 样例双路回退）。
- 前端：原生 HTML/CSS/JS + ECharts，避免引入构建工具链；图表统一遵循 A 股「红涨绿跌」。
- 任何改动都不应让界面在数据源失败时报错——始终回退样例、确保可用。

## 数据与合规

- 行情数据来自 AkShare 等公开接口，仅用于研究参考，**不构成投资建议**。
- 请勿提交 `data/app.db`、`.env` 等运行时/敏感文件（已纳入 `.gitignore`）。
- 如需新增数据源，请确认其使用条款允许再分发与开源引用。

## 提交 Issue

- Bug：请附复现步骤、浏览器/环境、相关接口返回（可隐藏个人信息）。
- 功能建议：请说明使用场景与预期收益。

提交前请确保本地能正常 `build.py` + `app.py` 启动，并通过基础自测。期待你的参与！
