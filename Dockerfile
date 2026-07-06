FROM python:3.11-slim

WORKDIR /app

# 编译依赖（akshare / pandas 部分扩展需要）
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 启动时先构建数据库（拉取 AkShare 实时数据；无网络/未安装时自动回退样例）
EXPOSE 8011

# 单 worker：避免 APScheduler 定时刷新在 gunicorn 多 worker 下重复触发；
# 个人投资者小流量场景单 worker 足够，且调度只跑一份。
CMD ["sh", "-c", "python build.py && gunicorn -w 1 -b 0.0.0.0:8011 --timeout 120 app:app"]
