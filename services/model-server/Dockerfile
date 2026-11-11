# ModelOps model server: one container per deployment revision.
#   docker build --target test -t ms:test . && docker run --rm --read-only --tmpfs /tmp ms:test
#   docker build --target runtime -t modelops/model-server:dev .   (pnpm dev:up builds it)
# The orchestrator starts it with: read-only rootfs, no capabilities, non-root, 0.5 CPU,
# 512 MB, and only the internal `inference` network (docs/02 §8).
FROM python:3.15.0-slim@sha256:f5b92f2a669a4c347044f29367f31983280b648250ca94dea66f98c53bc87e58 AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /bin/uv
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
COPY model_server ./model_server
COPY tests ./tests
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin server
USER 10001
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider"]

# ---- runtime -------------------------------------------------------------------------------
FROM base AS runtime
RUN uv sync --frozen --no-dev --no-install-project && rm /bin/uv
COPY model_server ./model_server
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin server
USER 10001
LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-model-server
EXPOSE 8000
CMD ["python", "-m", "model_server"]
