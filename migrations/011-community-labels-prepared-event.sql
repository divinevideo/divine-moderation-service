-- Persist the exact signed label event bytes in each decision claim.
-- claimDecision (src/community-labels/d1.mjs) stores the serialized signed
-- kind-1985 event here BEFORE publishing, and the sweep republishes it verbatim
-- on every retry. The relay dedups the byte-identical event by id, so a publish
-- that lands while the D1 confirm write fails can never mint a second
-- authoritative label id — even if the event-building code or signing key
-- changed between the first publish and a later retry.
--
-- Added as a follow-up ALTER (not folded into 010's CREATE TABLE) because 010
-- may already have been applied to an environment; wrangler applies each
-- migration file once by filename, so an edit to 010 would never reach an
-- environment where 010 already ran.
--
-- Run exactly once per environment. SQLite (and therefore D1) does not support
-- "ADD COLUMN IF NOT EXISTS"; a re-run errors with "duplicate column name".
-- That's the expected signal — treat the error as "already applied" and move on.

ALTER TABLE community_label_decisions
  ADD COLUMN prepared_event TEXT;
