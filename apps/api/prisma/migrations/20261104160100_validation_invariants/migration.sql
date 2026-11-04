-- Hand-written invariants for model versions (docs/03-data-model.md, section 2).
--  1. Content hashes are immutable once set: an artifact can never be swapped under a version.
--  2. VALIDATED is final: no code path may move a validated version back to another state.
CREATE FUNCTION model_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.artifact_sha256 IS NOT NULL AND NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256)
     OR (OLD.signature_sha256 IS NOT NULL AND NEW.signature_sha256 IS DISTINCT FROM OLD.signature_sha256)
     OR (OLD.golden_sha256 IS NOT NULL AND NEW.golden_sha256 IS DISTINCT FROM OLD.golden_sha256) THEN
    RAISE EXCEPTION 'model_versions: artifact hashes are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'VALIDATED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'model_versions: VALIDATED is a final state'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_versions_guard
  BEFORE UPDATE ON "model_versions"
  FOR EACH ROW EXECUTE FUNCTION model_versions_guard();
