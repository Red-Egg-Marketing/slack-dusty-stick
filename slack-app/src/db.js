// Thin data-access layer over the D1 `awards` table.
// All queries use prepared statements with bound parameters (no string
// interpolation) so user input can never alter the SQL.

/**
 * Insert a new award. Returns nothing meaningful; throws on failure.
 *
 * `source` is 'command' (a /dustystick slash command) or 'reaction' (someone
 * reacted with :dusty_stick:). `channelId` and `messageTs` are stored for
 * reaction awards so the row can be matched again if the reaction is removed;
 * for slash commands `messageTs` is typically null.
 */
export async function insertAward(
  db,
  {
    giverId,
    giverName,
    receiverId,
    receiverName,
    reason,
    source = "command",
    channelId = null,
    messageTs = null,
  }
) {
  await db
    .prepare(
      `INSERT INTO awards
         (giver_id, giver_name, receiver_id, receiver_name, reason, source, channel_id, message_ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      giverId,
      giverName,
      receiverId,
      receiverName,
      reason,
      source,
      channelId,
      messageTs,
      Date.now()
    )
    .run();
}

/**
 * Delete the reaction award matching a removed :dusty_stick: reaction.
 * Slack allows only one reaction of a given emoji per user per message, so
 * (source='reaction', giver, receiver, channel, message_ts) uniquely
 * identifies the row logged when the reaction was added.
 */
export async function deleteReactionAward(
  db,
  { giverId, receiverId, channelId, messageTs }
) {
  await db
    .prepare(
      `DELETE FROM awards
        WHERE source = 'reaction'
          AND giver_id = ?
          AND receiver_id = ?
          AND channel_id = ?
          AND message_ts = ?`
    )
    .bind(giverId, receiverId, channelId, messageTs)
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

/**
 * Weekly tally: receivers ranked by awards received since `sinceMs` (unix epoch
 * ms), most first. Used for the "Dusty Stick of the Week" prize. Returns the
 * same shape as getLeaderboard: { receiver_id, receiver_name, total }.
 */
export async function getWeeklyCounts(db, sinceMs) {
  const { results } = await db
    .prepare(
      `SELECT receiver_id,
              receiver_name,
              COUNT(*) AS total
         FROM awards
        WHERE created_at >= ?
        GROUP BY receiver_id
        ORDER BY total DESC, MAX(created_at) DESC`
    )
    .bind(sinceMs)
    .all();
  return results || [];
}
