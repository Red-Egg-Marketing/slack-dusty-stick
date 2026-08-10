-- Dusty Stick Awards — D1 schema
-- Run with: npm run db:init  (wrangler d1 execute dusty-stick --file=./schema.sql --remote)

CREATE TABLE IF NOT EXISTS awards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  giver_id      TEXT,
  giver_name    TEXT,
  receiver_id   TEXT,
  receiver_name TEXT,
  reason        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL  -- unix epoch milliseconds
);

-- Speeds up the leaderboard GROUP BY receiver_id query.
CREATE INDEX IF NOT EXISTS idx_awards_receiver_id ON awards (receiver_id);

-- Speeds up the "recent" query (ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS idx_awards_created_at ON awards (created_at);
