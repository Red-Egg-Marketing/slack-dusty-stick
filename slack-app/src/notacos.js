// The No-Taco Club — an inverse HeyTaco leaderboard (/notacos).
//
// Normally tacos are kudos, so a board of who's received the FEWEST is a
// tongue-in-cheek "clean plate" hall of fame. The catch: HeyTaco's leaderboard
// API only returns people who've received at least one taco, but the people we
// most want to feature are the ones sitting at zero. So we can't drive off the
// taco data alone — we join it against the Slack member roster (users.list) and
// treat anyone absent from HeyTaco's response as 0.
//
// Data sources (both server-side from the Worker; no D1):
//   • HeyTaco leaderboard  — GET https://www.heytaco.chat/api/v1/json/leaderboard/{teamId}?days=N
//                            → { leaderboard: [{ received_by_id, username, count }] }
//     The team id in the URL is the access key (no separate token). `count` is
//     tacos RECEIVED, as a string. The API has a ~5-minute cache.
//   • Slack users.list     — the workspace roster, using the bot's users:read scope.
//
// Config (see wrangler.toml):
//   HEYTACO_TEAM_ID — secret, required. Your HeyTaco team id (find it signed
//                     into HeyTaco). Treated as a credential → set via
//                     `wrangler secret put`, not as a plain var.
//   HEYTACO_DAYS    — var, optional. Leaderboard window in days (default 30).

import { escapeSlackText } from "./format.js";

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 15;

/**
 * Slogans for the No-Taco Club — openly (good-naturedly) ribbing the folks who
 * DO collect tacos, from the perspective of those too busy doing real work to
 * bother. One is picked at random for each board.
 */
export const NO_TACO_SLOGANS = [
  "While you were farming tacos, we shipped the thing.",
  "Cute taco pile. We were on a call with an actual client.",
  "Some of us work here. Some of us collect tacos.",
  "You've got tacos. We've got things done.",
  "Enjoy your condiments — we'll be over here running the place.",
  "Taco leaderboard champ: peaked in Slack.",
  "Nice tacos. Did any of them close a deal?",
  "Collecting tacos is a hobby. Ours is competence.",
  "One of us was in meetings. It wasn't the taco crowd.",
  "Tacos won't answer that client's email.",
  "Grinding tacos while the grown-ups grind work.",
  "Your taco streak is adorable. Our deadlines are not.",
  "Big taco energy, modest results energy.",
  "We don't chase tacos. Tacos are for people with time.",
];

/** Pick a random No-Taco Club slogan. */
export function randomSlogan() {
  return NO_TACO_SLOGANS[Math.floor(Math.random() * NO_TACO_SLOGANS.length)];
}

/**
 * Fetch tacos-received counts from HeyTaco. Returns a Map of
 * slackUserId → count (integer). Throws on missing config / HTTP / shape errors.
 */
export async function getTacoCounts(env, days = DEFAULT_DAYS) {
  const teamId = env.HEYTACO_TEAM_ID;
  if (!teamId) {
    throw new Error("HEYTACO_TEAM_ID is not configured");
  }

  const window = Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_DAYS;
  const url =
    `https://www.heytaco.chat/api/v1/json/leaderboard/${encodeURIComponent(teamId)}` +
    `?days=${encodeURIComponent(window)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`HeyTaco fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json().catch(() => null);
  const board = data && Array.isArray(data.leaderboard) ? data.leaderboard : null;
  if (!board) {
    throw new Error("HeyTaco response missing a leaderboard array");
  }

  const counts = new Map();
  for (const row of board) {
    if (!row || !row.received_by_id) continue;
    const n = parseInt(row.count, 10);
    counts.set(row.received_by_id, Number.isFinite(n) ? n : 0);
  }
  return counts;
}

/**
 * Fetch the workspace roster via Slack users.list (paginated), filtered to
 * real people: no bots, no deactivated accounts, no Slackbot. Returns an array
 * of { id, name } where name prefers the display name, then real name.
 * Throws on a Slack API error (e.g. missing users:read scope).
 */
export async function getWorkspaceMembers(env) {
  const members = [];
  let cursor = "";

  // Bound the loop defensively so a misbehaving cursor can't spin forever.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch("https://slack.com/api/users.list?" + params, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(`users.list failed: ${data.error || "unknown"}`);
    }

    for (const m of data.members || []) {
      if (!m || m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
      const profile = m.profile || {};
      const name =
        profile.display_name ||
        profile.real_name ||
        m.real_name ||
        m.name ||
        m.id;
      members.push({ id: m.id, name });
    }

    cursor = data.response_metadata && data.response_metadata.next_cursor;
    if (!cursor) break;
  }

  return members;
}

/**
 * Join the roster with taco counts and rank ascending (fewest first, then
 * alphabetical). Returns { rows, extraZeros } where rows is the top `limit`
 * and extraZeros is how many additional people are also at 0 but didn't fit,
 * so the caller can add an "…and N more" line.
 */
export function buildInverseBoard(members, counts, limit = DEFAULT_LIMIT) {
  const ranked = members
    .map((m) => ({ id: m.id, name: m.name, count: counts.get(m.id) || 0 }))
    .sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));

  const rows = ranked.slice(0, limit);
  const shownIds = new Set(rows.map((r) => r.id));
  const extraZeros = ranked.filter(
    (r) => r.count === 0 && !shownIds.has(r.id)
  ).length;

  return { rows, extraZeros };
}

/**
 * Render the inverse board into Block Kit. Uses plain display names — NOT
 * <@mention> tokens — on purpose, so running the command doesn't ping the
 * people it lists. `:taco:` is a standard emoji and renders in mrkdwn.
 */
export function inverseTacoBlocks(rows, extraZeros = 0, slogan = randomSlogan()) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "The No-Taco Club", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:taco: _${escapeSlackText(slogan)}_`,
        },
      ],
    },
  ];

  if (!rows || rows.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Everybody's earned tacos — not a clean plate in sight. :taco:",
      },
    });
    return blocks;
  }

  const lines = rows.map((r) => {
    const badge = r.count === 0 ? "✨" : "•";
    const taco = `${r.count} :taco:`;
    return `${badge} *${escapeSlackText(r.name)}* — ${taco}`;
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  if (extraZeros > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `…and ${extraZeros} more with a spotless 0 :taco:`,
        },
      ],
    });
  }

  return blocks;
}
