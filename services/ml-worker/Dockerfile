# ModelOps ML worker (bundle validation).
#   docker build --target test -t mw:test . && docker run --rm --read-only --tmpfs /tmp mw:test
#                                     runs the test suite on Linux (incl. the rlimit memory test)
#   docker build --target runtime .   the service image
FROM python:3.12.16-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./

# ---- tests ---------------------------------------------------------------------------------
FROM base AS test
RUN uv sync --frozen --no-install-project
COPY ml_worker ./ml_worker
COPY tests ./tests
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin worker
USER 10001
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider"]

# ---- runtime -------------------------------------------------------------------------------
FROM base AS runtime
RUN uv sync --frozen --no-dev --no-install-project && rm /bin/uv
COPY ml_worker ./ml_worker
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin worker
USER 10001
LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-ml-worker
EXPOSE 8000
# Two workers: one validation can occupy a worker for up to the sandbox wall limit.
CMD ["uvicorn", "ml_worker.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-server-header"]
