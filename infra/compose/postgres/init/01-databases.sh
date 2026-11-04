#!/bin/sh
# Runs once, on the first start of an empty Postgres volume.
# Creates two databases, each owned by its own least-privilege login role:
#   modelops  <- the NestJS control plane (Prisma migrations run as this role)
#   mlflow    <- the MLflow tracking server
# The superuser password is only used for administration, never by applications.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$MO_DB_APP_USER" -v app_pw="$MO_DB_APP_PASSWORD" \
  -v ml_user="$MO_DB_MLFLOW_USER" -v ml_pw="$MO_DB_MLFLOW_PASSWORD" <<'SQL'
-- CREATEDB is needed only so `prisma migrate dev` can create its temporary shadow database (dev only).
CREATE ROLE :"app_user" LOGIN CREATEDB PASSWORD :'app_pw';
CREATE ROLE :"ml_user" LOGIN PASSWORD :'ml_pw';

CREATE DATABASE modelops OWNER :"app_user";
CREATE DATABASE mlflow OWNER :"ml_user";

REVOKE ALL ON DATABASE modelops FROM PUBLIC;
REVOKE ALL ON DATABASE mlflow FROM PUBLIC;
SQL

echo "modelops-init: created databases 'modelops' and 'mlflow'"
