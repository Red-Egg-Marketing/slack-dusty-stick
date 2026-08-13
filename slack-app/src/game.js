// Red Egg arcade high-score board.
//
// This is a SEPARATE data source from the Dusty Stick awards: the game's
// scores live in the WordPress plugin's `wp_game` table (MySQL), exposed via a
// read-only REST endpoint. We fetch that over HTTP and render it as Block Kit.
// Nothing here touches D1.
//
// Config (see wrangler.toml):
//   GAME_API_BASE  — base URL of the WordPress site hosting the game plugin
//                    (e.g. https://redeggmarketing.com). Required.
//   GAME_API_TOKEN — optional shared secret. If set, it's sent as the
//                    X-Red-Egg-Token header; the plugin can require a match.

import { escapeSlackText } from "./format.js";

const DEFAULT_LIMIT = 10;
const REST_PATH = "/wp-json/red-egg-game/v1/leaderboard";

/**
 * Fetch the top scores from the WordPress game plugin.
 *
 * Returns an array of { name, score } ordered highest-first (the endpoint
 * already sorts). Throws on missing config / network / HTTP / shape errors so
 * the caller can show a friendly failure message rather than a broken board.
 */
export async function getGameLeaderboard(env, limit = DEFAULT_LIMIT) {
  const base = (env.GAME_API_BASE || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("GAME_API_BASE is not configured");
  }

  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : DEFAULT_LIMIT;
  const url = `${base}${REST_PATH}?limit=${encodeURIComponent(n)}`;

  // WP hosts (WP Engine, Sucuri, Cloudflare Bot Fight, etc.) routinely 403
  // server-to-server requests that arrive from datacenter IPs with a blank or
  // bot-looking User-Agent. Present a normal browser UA so the leaderboard
  // fetch isn't mistaken for a scraper. (If the host blocks by IP regardless,
  // use the shared-token path + a WAF allow rule instead — see README.)
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
  if (env.GAME_API_TOKEN) {
    headers["X-Red-Egg-Token"] = env.GAME_API_TOKEN;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Leaderboard fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new Error("Leaderboard response was not a JSON array");
  }

  // Defensive normalisation: keep only rows with a numeric score, coerce types,
  // and never trust the shape. Email is not requested and is ignored if present.
  return data
    .filter((row) => row && typeof row.score === "number" && Number.isFinite(row.score))
    .map((row) => ({
      name: String(row.name || "Anonymous"),
      score: Math.trunc(row.score),
    }));
}

/** Positive-leaderboard rank badge: medals for the podium, numbers after. */
export function scoreBadge(index) {
  switch (index) {
    case 0:
      return "🥇";
    case 1:
      return "🥈";
    case 2:
      return "🥉";
    default:
      return `${index + 1}.`;
  }
}

/** Thousands-separate an integer without relying on Intl in the Worker runtime. */
export function formatScore(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Render the high-score rows (each { name, score }) into Block Kit blocks.
 * Handles the empty state.
 */
export function gameLeaderboardBlocks(rows) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Red Egg High Scores", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":fire: Top runs in the Red Egg arcade — think you can top it?",
        },
      ],
    },
  ];

  if (!rows || rows.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No scores on the board yet — go set one. :video_game:",
      },
    });
    return blocks;
  }

  const lines = rows.map((row, i) => {
    const name = escapeSlackText(row.name);
    return `${scoreBadge(i)} *${name}* — ${formatScore(row.score)}`;
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  return blocks;
}
