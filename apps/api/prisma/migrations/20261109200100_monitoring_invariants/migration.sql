-- Hand-written invariants for M7 (docs/03, FR-32).

-- 1. The `champion` alias is gated: it can only move to a VALIDATED version together with a
--    COMPLETED, PASSED evaluation of exactly that version, run against the previous champion
--    (the baseline). Even code that bypasses the API cannot crown an unevaluated model.
CREATE FUNCTION registered_models_champion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ev RECORD;
  mv_status "ModelVersionStatus";
BEGIN
  IF NEW.champion_version_id IS NOT DISTINCT FROM OLD.champion_version_id
     AND NEW.champion_evaluation_id IS NOT DISTINCT FROM OLD.champion_evaluation_id THEN
    RETURN NEW;
  END IF;
  IF NEW.champion_version_id IS NULL OR NEW.champion_evaluation_id IS NULL THEN
    RAISE EXCEPTION 'registered_models: champion needs both a version and its passing evaluation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO ev FROM evaluation_reports WHERE id = NEW.champion_evaluation_id;
  IF ev IS NULL OR ev.status <> 'COMPLETED' OR NOT ev.passed THEN
    RAISE EXCEPTION 'registered_models: champion evaluation % did not pass', NEW.champion_evaluation_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ev.model_id <> NEW.id OR ev.candidate_version_id <> NEW.champion_version_id THEN
    RAISE EXCEPTION 'registered_models: that evaluation is for another model or version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ev.baseline_version_id IS DISTINCT FROM OLD.champion_version_id THEN
    RAISE EXCEPTION 'registered_models: the evaluation must compare against the current champion'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT status INTO mv_status FROM model_versions WHERE id = NEW.champion_version_id;
  IF mv_status IS DISTINCT FROM 'VALIDATED' THEN
    RAISE EXCEPTION 'registered_models: champion must be a VALIDATED version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER registered_models_champion_guard
  BEFORE UPDATE ON "registered_models"
  FOR EACH ROW EXECUTE FUNCTION registered_models_champion_guard();

-- A brand-new model cannot be inserted with a champion either.
ALTER TABLE "registered_models"
  ADD CONSTRAINT "registered_models_champion_pair"
  CHECK ((champion_version_id IS NULL) = (champion_evaluation_id IS NULL));

-- 2. Reports are evidence: append-only, like the audit log.
CREATE FUNCTION reports_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: reports are append-only', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER evaluation_reports_append_only
  BEFORE UPDATE ON "evaluation_reports"
  FOR EACH ROW EXECUTE FUNCTION reports_append_only();

CREATE TRIGGER drift_reports_append_only
  BEFORE UPDATE ON "drift_reports"
  FOR EACH ROW EXECUTE FUNCTION reports_append_only();
