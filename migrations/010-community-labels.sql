-- Community content-warning aggregation (#180, divine-mobile #4771).
-- Decisions: publish-once dedup + audit trail for authoritative labels.
-- Strikes: per-creator accounting when the community had to label for them.
-- Warnings: send-once record per escalation level.

-- status: 'pending' once the sweep claims (video,label) BEFORE publishing,
-- 'confirmed' after the publish lands. The claim persists prepared_event: the
-- exact signed label event, serialized, is stored BEFORE publishing and
-- replayed verbatim on every retry. The relay dedups by id, so a publish that
-- succeeds while the D1 confirm write fails can never produce a duplicate
-- authoritative label — even if the event-building code or signing key changes
-- between the first publish and a later retry.
CREATE TABLE IF NOT EXISTS community_label_decisions (
  video_event_id     TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  vote_count         INTEGER NOT NULL,
  published_event_id TEXT    NOT NULL,
  video_sha256       TEXT,
  creator_pubkey     TEXT    NOT NULL,
  prepared_event     TEXT,
  created_at         INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending',
  PRIMARY KEY (video_event_id, label)
);

CREATE INDEX IF NOT EXISTS idx_community_label_decisions_creator
  ON community_label_decisions (creator_pubkey);

CREATE TABLE IF NOT EXISTS community_strikes (
  creator_pubkey  TEXT    NOT NULL,
  video_event_id  TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (creator_pubkey, video_event_id, label)
);

-- status: 'pending' once the warning intent is claimed BEFORE the DM is sent,
-- 'sent' after it lands. Claiming first means a crash (or record failure)
-- between claim and send blocks a resend on the next tick — a rare missed
-- warning traded for never double-DMing the creator. sent_at is the claim
-- time (the send attempt), not a proof of delivery.
CREATE TABLE IF NOT EXISTS community_strike_warnings (
  creator_pubkey  TEXT    NOT NULL,
  warning_level   INTEGER NOT NULL,
  sent_at         INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  PRIMARY KEY (creator_pubkey, warning_level)
);
