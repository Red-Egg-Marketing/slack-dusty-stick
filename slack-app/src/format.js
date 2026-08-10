// Formatting helpers: text escaping, relative time, and Block Kit builders
// shared between the slash-command responses and the App Home view.

/**
 * Escape text that will be placed inside Slack message text / mrkdwn so that
 * user-supplied content cannot break formatting or inject control characters.
 * Slack requires &, <, and > to be HTML-escaped in message text.
 * https://api.slack.com/reference/surfaces/formatting#escaping
 */
export function escapeSlackText(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Human-friendly relative time, e.g. "3 hours ago", from a ms timestamp. */
export function relativeTime(fromMs, nowMs = Date.now()) {
  const diff = Math.max(0, nowMs - fromMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? "" : "s"} ago`;
  const yr = Math.floor(mon / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

/** Medal/crown emoji for a 0-based leaderboard rank; number otherwise. */
export function rankBadge(index) {
  switch (index) {
    case 0:
      return "👑";
    case 1:
      return "🥈";
    case 2:
      return "🥉";
    default:
      return `${index + 1}.`;
  }
}

/**
 * Render a leaderboard rows array (each { receiver_id, receiver_name, total })
 * into Block Kit blocks. Handles the empty state.
 */
export function leaderboardBlocks(rows, { header = true } = {}) {
  const blocks = [];

  if (header) {
    // NOTE: custom emoji (:dusty_stick:) don't reliably render in a plain_text
    // header block — they can show as literal text — so the header keeps the
    // trophy only, and the :dusty_stick: shows in the mrkdwn count/empty lines
    // below (and in this context line) where custom emoji render correctly.
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "🏆 Dusty Stick Leaderboard", emoji: true },
    });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: ":dusty_stick: Most dusty sticks earned" }],
    });
  }

  if (!rows || rows.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No dusty sticks awarded yet. Be the first — `/dustystick @someone <reason>` :dusty_stick:",
      },
    });
    return blocks;
  }

  const lines = rows.map((row, i) => {
    const badge = rankBadge(i);
    const name = mentionOrName(row.receiver_id, row.receiver_name);
    const count = `${row.total} :dusty_stick:`;
    return `${badge} ${name} — *${count}*`;
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  return blocks;
}

/**
 * Prefer a live Slack mention (<@U123>) when we have the user id, so names
 * render/link correctly; fall back to the escaped stored name otherwise.
 */
export function mentionOrName(userId, name) {
  if (userId) return `<@${userId}>`;
  return escapeSlackText(name || "someone");
}
