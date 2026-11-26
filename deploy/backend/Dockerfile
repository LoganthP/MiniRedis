# Build a single image for the dashboard, API, and database.
# Build from the repository root:
#   docker build -f deploy/backend/Dockerfile -t miniredis-backend .
FROM node:22-bookworm-slim AS dashboard
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt
COPY server/miniredis ./server/miniredis
COPY api/app ./api/app
COPY --from=dashboard /web/dist /app/dashboard

# Register the dashboard after the API routes, so both share one HTTPS origin.
RUN printf '%s\n' '' \
    'from starlette.staticfiles import StaticFiles' \
    'app.mount("/", StaticFiles(directory="/app/dashboard", html=True), name="dashboard")' \
    >> /app/api/app/main.py
COPY deploy/backend/start.sh ./start.sh
RUN python -m compileall -q /app/server/miniredis /app/api/app \
 && chmod +x /app/start.sh \
 && useradd --uid 10001 --create-home miniredis \
 && mkdir -p /data /data/reports && chown -R miniredis /data
# Starts as root only to fix ownership of a mounted disk (Render/Fly mount
# volumes owned by root); start.sh then drops to the miniredis user.
VOLUME ["/data"]
ENV PORT=8000 MINIREDIS_DIR=/data REPORTS_DIR=/data/reports \
    DB_HOST=127.0.0.1 DB_PORT=6380 ALLOW_CRASH_DEMO=true
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=2)"]
STOPSIGNAL SIGTERM
CMD ["/app/start.sh"]
