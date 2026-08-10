-- Dusty Stick Awards — D1 schema
-- Run with: npm run db:init  (wrangler d1 execute dusty-stick --file=./schema.sql --remote)
--
-- NOTE: This is the schema for a FRESH install. If you created the database
-- before reaction support was added (i.e. the awards table has no `source`,
-- `channel_id`, or `message_ts` columns), do NOT re-run this file — instead run
-- the migration once:  npm run db:migrate

CREATE TABLE IF NOT EXISTS awards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  giver_id      TEXT,
  giver_name    TEXT,
  receiver_id   TEXT,
  receiver_name TEXT,
  reason        TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'command',  -- 'command' | 'reaction'
  channel_id    TEXT,                                -- channel the award relates to (nullable)
  message_ts    TEXT,                                -- reacted-to message ts (reaction awards only)
  created_at    INTEGER NOT NULL  -- unix epoch milliseconds
);

-- Speeds up the leaderboard GROUP BY receiver_id query.
CREATE INDEX IF NOT EXISTS idx_awards_receiver_id ON awards (receiver_id);

-- Speeds up the "recent" query (ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS idx_awards_created_at ON awards (created_at);

-- Speeds up reaction-removal matching (DELETE ... WHERE source, giver, receiver, channel, ts).
CREATE INDEX IF NOT EXISTS idx_awards_reaction_match
  ON awards (source, giver_id, receiver_id, channel_id, message_ts);
