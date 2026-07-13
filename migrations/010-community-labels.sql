-- Community content-warning aggregation (#180, divine-mobile #4771).
-- Decisions: publish-once dedup + audit trail for authoritative labels.
-- Strikes: per-creator accounting when the community had to label for them.
-- Warnings: send-once record per escalation level.

CREATE TABLE IF NOT EXISTS community_label_decisions (
  video_event_id     TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  vote_count         INTEGER NOT NULL,
  published_event_id TEXT    NOT NULL,
  video_sha256       TEXT,
  creator_pubkey     TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS community_strike_warnings (
  creator_pubkey  TEXT    NOT NULL,
  strike_count    INTEGER NOT NULL,
  sent_at         INTEGER NOT NULL,
  PRIMARY KEY (creator_pubkey, strike_count)
);
