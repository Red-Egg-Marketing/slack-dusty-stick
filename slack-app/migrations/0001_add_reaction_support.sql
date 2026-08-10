-- Migration 0001 — add reaction-award support to an existing `awards` table.
--
-- Run this ONCE, and ONLY if you created the database BEFORE reaction support
-- was added (i.e. your awards table predates the `source` / `channel_id` /
-- `message_ts` columns). Fresh installs get these from schema.sql and must NOT
-- run this migration.
--
--   npm run db:migrate
--   (wrangler d1 execute dusty-stick --file=./migrations/0001_add_reaction_support.sql --remote)
--
-- SQLite's ALTER TABLE ADD COLUMN has no IF NOT EXISTS. If a column already
-- exists the statement errors out ("duplicate column name"); that just means
-- your DB is already migrated and you can ignore it.

ALTER TABLE awards ADD COLUMN source TEXT NOT NULL DEFAULT 'command';
ALTER TABLE awards ADD COLUMN channel_id TEXT;
ALTER TABLE awards ADD COLUMN message_ts TEXT;

-- Speeds up reaction-removal matching (DELETE ... WHERE source, giver, receiver, channel, ts).
CREATE INDEX IF NOT EXISTS idx_awards_reaction_match
  ON awards (source, giver_id, receiver_id, channel_id, message_ts);
