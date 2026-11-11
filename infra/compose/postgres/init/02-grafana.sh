#!/bin/sh
# M10: Grafana's read-only role. Runs on the first start of an empty volume, and again (it is
# idempotent) from `pnpm dev:obs`, after migrations, to grant SELECT on the operational tables.
# MO_GRAFANA_DB picks the database (default modelops; `pnpm kind:up` passes modelops_kind).
# Deliberately NOT granted: users, sessions, api_keys, invitations, audit_events, prediction data.
set -eu

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${MO_GRAFANA_DB:-modelops}" \
  -v db="${MO_GRAFANA_DB:-modelops}" -v ro_user="$MO_DB_GRAFANA_USER" \
  -v ro_pw="$MO_DB_GRAFANA_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'ro_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ro_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'ro_user', :'ro_pw') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'ro_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'ro_user') \gexec
SELECT format('GRANT SELECT ON %I TO %I', t, :'ro_user')
  FROM unnest(ARRAY['organizations', 'projects', 'registered_models', 'model_versions',
                    'validation_reports', 'endpoints', 'deployment_revisions', 'deployment_events',
                    'drift_reports', 'evaluation_reports', 'canary_checks', 'approvals',
                    'outbox_messages']) AS t
 WHERE to_regclass('public.' || t) IS NOT NULL \gexec
SQL

echo "modelops-init: read-only role for Grafana is ready on ${MO_GRAFANA_DB:-modelops}"
