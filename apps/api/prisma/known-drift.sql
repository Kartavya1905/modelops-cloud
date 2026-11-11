-- Differences between the migrated database and schema.prisma that are expected: objects the
-- migrations create in raw SQL because Prisma's schema language cannot express them.
-- `scripts/check-migrations.mjs` (CI job `migrations`) fails on any OTHER difference, e.g. a model
-- change without a migration. Comment lines are ignored; one statement per line.
--
-- M9 audit hash chain: UNIQUE (org_id, chain_seq) NULLS NOT DISTINCT (migration
-- 20261111100000_audit_hash_chain). Prisma models a unique index but not NULLS NOT DISTINCT.
DROP INDEX "audit_events_chain_position";
