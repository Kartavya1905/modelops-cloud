-- Hand-written invariants for deployments (docs/03-data-model.md section 2, docs/05).

-- 1. At most one in-progress revision per endpoint: two concurrent deploys cannot race.
CREATE UNIQUE INDEX "deployment_revisions_one_in_progress"
  ON "deployment_revisions" ("endpoint_id")
  WHERE "state" IN ('REQUESTED', 'AWAITING_APPROVAL', 'QUEUED', 'PROVISIONING', 'LOADING', 'VERIFYING');

-- 2. SEC-6: a revision can only be created for a VALIDATED model version of the same org,
--    even if the API check is bypassed.
CREATE FUNCTION deployment_revisions_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mv_status "ModelVersionStatus";
  mv_org uuid;
  ep_org uuid;
BEGIN
  SELECT status, org_id INTO mv_status, mv_org FROM model_versions WHERE id = NEW.model_version_id;
  IF mv_status IS DISTINCT FROM 'VALIDATED' THEN
    RAISE EXCEPTION 'deployment_revisions: model version % is not VALIDATED', NEW.model_version_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT org_id INTO ep_org FROM endpoints WHERE id = NEW.endpoint_id;
  IF mv_org IS DISTINCT FROM NEW.org_id OR ep_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'deployment_revisions: endpoint, model version and revision must share an org'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deployment_revisions_insert_guard
  BEFORE INSERT ON "deployment_revisions"
  FOR EACH ROW EXECUTE FUNCTION deployment_revisions_insert_guard();

-- 3. Terminal states are final, a revision never changes endpoint or model version, and every
--    state change bumps state_version (the compare-and-set counter).
CREATE FUNCTION deployment_revisions_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('FAILED', 'CANCELLED', 'RETIRED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'deployment_revisions: % is a terminal state', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.model_version_id IS DISTINCT FROM OLD.model_version_id THEN
    RAISE EXCEPTION 'deployment_revisions: endpoint and model version are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state_version <= OLD.state_version THEN
    RAISE EXCEPTION 'deployment_revisions: a state change must increment state_version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deployment_revisions_update_guard
  BEFORE UPDATE ON "deployment_revisions"
  FOR EACH ROW EXECUTE FUNCTION deployment_revisions_update_guard();

-- 4. The stable revision of an endpoint belongs to that endpoint and is serving
--    (READY, DEGRADED while it heals, or DRAINING only during a fast rollback, M8).
CREATE FUNCTION endpoints_stable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rev_endpoint uuid;
  rev_state "RevisionState";
BEGIN
  IF NEW.stable_revision_id IS NULL OR NEW.stable_revision_id IS NOT DISTINCT FROM OLD.stable_revision_id THEN
    RETURN NEW;
  END IF;
  SELECT endpoint_id, state INTO rev_endpoint, rev_state
    FROM deployment_revisions WHERE id = NEW.stable_revision_id;
  IF rev_endpoint IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'endpoints: stable revision belongs to another endpoint'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF rev_state NOT IN ('READY', 'DEGRADED', 'DRAINING') THEN
    RAISE EXCEPTION 'endpoints: stable revision must be READY (is %)', rev_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER endpoints_stable_guard
  BEFORE UPDATE ON "endpoints"
  FOR EACH ROW EXECUTE FUNCTION endpoints_stable_guard();
