-- Hand-written invariants for M8 (docs/05 §2 and §6, FR-41): canary traffic and approvals.

-- 1. Canary weight: 0-50 %, and only with a canary; the canary is never the stable revision.
ALTER TABLE "endpoints"
  ADD CONSTRAINT "endpoints_canary_weight_range" CHECK (canary_weight BETWEEN 0 AND 50),
  ADD CONSTRAINT "endpoints_canary_weight_needs_canary"
    CHECK (canary_revision_id IS NOT NULL OR canary_weight = 0),
  ADD CONSTRAINT "endpoints_canary_not_stable"
    CHECK (canary_revision_id IS NULL OR canary_revision_id IS DISTINCT FROM stable_revision_id);

ALTER TABLE "deployment_revisions"
  ADD CONSTRAINT "deployment_revisions_canary_weight_range"
    CHECK (canary_weight IS NULL OR canary_weight BETWEEN 0 AND 50),
  ADD CONSTRAINT "deployment_revisions_canary_weight_strategy"
    CHECK ((strategy = 'CANARY') = (canary_weight IS NOT NULL));

-- 2. The canary revision belongs to the endpoint and is serving (READY, or DEGRADED while it heals).
CREATE FUNCTION endpoints_canary_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rev_endpoint uuid;
  rev_state "RevisionState";
BEGIN
  IF NEW.canary_revision_id IS NULL OR NEW.canary_revision_id IS NOT DISTINCT FROM OLD.canary_revision_id THEN
    RETURN NEW;
  END IF;
  SELECT endpoint_id, state INTO rev_endpoint, rev_state
    FROM deployment_revisions WHERE id = NEW.canary_revision_id;
  IF rev_endpoint IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'endpoints: canary revision belongs to another endpoint'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF rev_state NOT IN ('READY', 'DEGRADED') THEN
    RAISE EXCEPTION 'endpoints: canary revision must be READY (is %)', rev_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER endpoints_canary_guard
  BEFORE UPDATE ON "endpoints"
  FOR EACH ROW EXECUTE FUNCTION endpoints_canary_guard();

-- 3. Four eyes: nobody approves (or rejects) their own deployment, and a decision has a decider.
ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_four_eyes"
    CHECK (decided_by_id IS NULL OR decided_by_id <> requested_by_id),
  ADD CONSTRAINT "approvals_decision_has_decider"
    CHECK ((status IN ('APPROVED', 'REJECTED')) = (decided_by_id IS NOT NULL AND decided_at IS NOT NULL));

-- 4. Approval gate on the revision itself, even if the API is bypassed:
--    AWAITING_APPROVAL -> QUEUED only with an APPROVED approval, and a PRODUCTION revision can
--    skip AWAITING_APPROVAL only when it redeploys a version that already served this endpoint
--    (slow rollback, rollback_of_id).
CREATE FUNCTION deployment_revisions_approval_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  env "EndpointEnvironment";
  approved boolean;
  earlier RECORD;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state <> 'QUEUED' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'AWAITING_APPROVAL' THEN
    SELECT status = 'APPROVED' INTO approved FROM approvals WHERE revision_id = NEW.id;
    IF approved IS NOT TRUE THEN
      RAISE EXCEPTION 'deployment_revisions: % needs an approved approval to be queued', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT environment INTO env FROM endpoints WHERE id = NEW.endpoint_id;
  IF env = 'PRODUCTION' THEN
    SELECT endpoint_id, model_version_id, ready_at INTO earlier
      FROM deployment_revisions WHERE id = NEW.rollback_of_id;
    IF NEW.rollback_of_id IS NULL OR earlier.endpoint_id IS DISTINCT FROM NEW.endpoint_id
       OR earlier.model_version_id IS DISTINCT FROM NEW.model_version_id OR earlier.ready_at IS NULL THEN
      RAISE EXCEPTION 'deployment_revisions: production deployments need an approval'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deployment_revisions_approval_guard
  BEFORE UPDATE ON "deployment_revisions"
  FOR EACH ROW EXECUTE FUNCTION deployment_revisions_approval_guard();

-- 5. Canary checks are evidence: never edited, like evaluation and drift reports (M7).
CREATE TRIGGER canary_checks_append_only
  BEFORE UPDATE ON "canary_checks"
  FOR EACH ROW EXECUTE FUNCTION reports_append_only();
