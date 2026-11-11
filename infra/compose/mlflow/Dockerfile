# MLflow tracking server + model registry, with the drivers the upstream image lacks:
#   psycopg2 -> PostgreSQL backend store
#   boto3    -> S3-compatible artifact store (SeaweedFS)
FROM python:3.12.16-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY init_buckets.py /opt/modelops/init_buckets.py

# Run as an unprivileged user; the container filesystem is mounted read-only in Compose.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin mlflow
USER 10001
WORKDIR /tmp

LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-mlflow

EXPOSE 5000
