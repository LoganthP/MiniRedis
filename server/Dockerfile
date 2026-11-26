FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY miniredis ./miniredis
# Precompile bytecode at build time: the runtime user cannot write
# __pycache__, so without this every restart would recompile the package.
RUN python -m compileall -q /app/miniredis \
 && useradd --uid 10001 --create-home miniredis \
 && mkdir -p /data && chown miniredis /data
USER miniredis
VOLUME ["/data"]
EXPOSE 6380
ENV MINIREDIS_HOST=0.0.0.0 MINIREDIS_PORT=6380 MINIREDIS_DIR=/data
# Readiness: healthy only once recovery finished and status is "ready".
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-m", "miniredis.healthcheck"]
STOPSIGNAL SIGTERM
# The fork-based supervisor restarts a crashed server in ~1 ms from a warm
# parent process; Docker's restart policy remains the outer safety net.
CMD ["python", "-m", "miniredis.supervise"]
