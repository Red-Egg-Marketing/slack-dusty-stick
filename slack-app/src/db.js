// Thin data-access layer over the D1 `awards` table.
// All queries use prepared statements with bound parameters (no string
// interpolation) so user input can never alter the SQL.

/** Insert a new award. Returns nothing meaningful; throws on failure. */
export async function insertAward(db, { giverId, giverName, receiverId, receiverName, reason }) {
  await db
    .prepare(
      `INSERT INTO awards (giver_id, giver_name, receiver_id, receiver_name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(giverId, giverName, receiverId, receiverName, reason, Date.now())
    .run();
}

/**
 * Leaderboard: receivers ranked by number of awards received, most first.
 * We pick the most recent receiver_name for display via MAX(created_at).
 */
export async function getLeaderboard(db, limit = 15) {
  const { results } = await db
    .prepare(
      `SELECT receiver_id,
              receiver_name,
              COUNT(*) AS total
         FROM awards
        GROUP BY receiver_id
        ORDER BY total DESC, MAX(created_at) DESC
        LIMIT ?`
    )
    .bind(limit)
    .all();
  return results || [];
}

/** Most recent awards, newest first. */
export async function getRecent(db, limit = 10) {
  const { results } = await db
    .prepare(
      `SELECT giver_id, giver_name, receiver_id, receiver_name, reason, created_at
         FROM awards
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(limit)
    .all();
  return results || [];
}
