-- M9: tamper-evident audit log (docs/06). The append-only trigger (M2) stops the application from
-- changing history; the hash chain makes any change by anyone else (a superuser, a restored
-- backup, an edited dump) detectable: every event commits to the one before it.

ALTER TABLE "audit_events"
  ADD COLUMN "chain_seq" BIGINT,
  ADD COLUMN "prev_hash" BYTEA,
  ADD COLUMN "hash" BYTEA;

-- What an event's hash covers: the previous hash and every column, unambiguously separated
-- (unit separator, 0x1F). jsonb::text is canonical (sorted keys), timestamps are UTC microseconds.
CREATE FUNCTION audit_event_digest(prev bytea, e audit_events) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(coalesce(prev, ''::bytea) || convert_to(concat_ws(chr(31),
    e.id::text,
    coalesce(e.org_id::text, ''),
    e.actor_type::text,
    coalesce(e.actor_id::text, ''),
    e.action,
    coalesce(e.target_type, ''),
    coalesce(e.target_id, ''),
    e.metadata::text,
    coalesce(e.request_id, ''),
    coalesce(e.ip_hash, ''),
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8'))
$$;

-- Backfill existing chains (one per organization, plus one for org-less events), in id order.
ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete";
DO $$
DECLARE
  r audit_events;
  cur_org uuid;
  first boolean := true;
  seq bigint := 0;
  prev bytea := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY org_id NULLS FIRST, id LOOP
    IF first OR r.org_id IS DISTINCT FROM cur_org THEN
      cur_org := r.org_id; seq := 0; prev := NULL; first := false;
    END IF;
    seq := seq + 1;
    UPDATE audit_events
       SET chain_seq = seq, prev_hash = prev, hash = audit_event_digest(prev, r)
     WHERE id = r.id;
    prev := audit_event_digest(prev, r);
  END LOOP;
END $$;
ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete";

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_chained" CHECK (chain_seq IS NOT NULL AND hash IS NOT NULL);
CREATE UNIQUE INDEX "audit_events_chain_position"
  ON "audit_events" ("org_id", "chain_seq") NULLS NOT DISTINCT;

-- Every insert extends its chain. The advisory lock serialises inserts per chain (until the
-- transaction ends), so two concurrent events can never both claim the same predecessor.
CREATE FUNCTION audit_events_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || coalesce(NEW.org_id::text, '-'), 0));
  IF NEW.org_id IS NULL THEN
    SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_events
     WHERE org_id IS NULL ORDER BY chain_seq DESC LIMIT 1;
  ELSE
    SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_events
     WHERE org_id = NEW.org_id ORDER BY chain_seq DESC LIMIT 1;
  END IF;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := audit_event_digest(last_hash, NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

-- Recomputes one chain. Returns the number of events checked, and the first position that does
-- not verify (NULL when the whole chain is intact) with the reason.
CREATE FUNCTION audit_chain_verify(p_org uuid)
RETURNS TABLE (checked bigint, broken_at bigint, reason text, head text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_events;
  expect_seq bigint := 1;
  prev bytea := NULL;
BEGIN
  checked := 0;
  FOR r IN SELECT * FROM audit_events
            WHERE org_id IS NOT DISTINCT FROM p_org ORDER BY chain_seq LOOP
    IF r.chain_seq <> expect_seq THEN
      broken_at := expect_seq; reason := 'missing event (gap in the chain)';
      RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM prev THEN
      broken_at := r.chain_seq; reason := 'previous hash does not match';
      RETURN NEXT; RETURN;
    END IF;
    IF r.hash IS DISTINCT FROM audit_event_digest(prev, r) THEN
      broken_at := r.chain_seq; reason := 'event content changed';
      RETURN NEXT; RETURN;
    END IF;
    prev := r.hash;
    expect_seq := expect_seq + 1;
    checked := checked + 1;
  END LOOP;
  head := encode(prev, 'hex');
  RETURN NEXT;
END;
$$;
