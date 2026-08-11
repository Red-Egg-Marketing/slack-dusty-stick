// Lightweight functional test for the /highscores game leaderboard.
//
// No test framework — just `node test/game.test.js` (or `npm test`). Stubs
// global fetch to model the WordPress REST endpoint, and asserts fetch/parse
// behaviour, type normalisation, the shared-token header, error handling, and
// Block Kit rendering.

import assert from "node:assert";
import {
  getGameLeaderboard,
  gameLeaderboardBlocks,
  scoreBadge,
  formatScore,
} from "../src/game.js";

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

async function run() {
  // --- happy path: fetches, sorts already done server-side, normalises types.
  {
    let calledUrl = null;
    let sentHeaders = null;
    globalThis.fetch = async (url, opts) => {
      calledUrl = String(url);
      sentHeaders = (opts && opts.headers) || {};
      return okJson([
        { name: "Jacob", score: 4200 },
        { name: "Lucas", score: 3100 },
        // score as a string should be dropped (defensive), email ignored.
        { name: "Bad", score: "999", email: "x@y.com" },
      ]);
    };

    const rows = await getGameLeaderboard(
      { GAME_API_BASE: "https://example.com/" },
      10
    );

    assert.equal(
      calledUrl,
      "https://example.com/wp-json/red-egg-game/v1/leaderboard?limit=10",
      "builds the endpoint URL and strips the trailing slash on the base"
    );
    assert.equal(sentHeaders.Accept, "application/json");
    assert.ok(!("X-Red-Egg-Token" in sentHeaders), "no token header when unset");
    assert.deepEqual(rows, [
      { name: "Jacob", score: 4200 },
      { name: "Lucas", score: 3100 },
    ]);
  }

  // --- sends the shared-secret header when GAME_API_TOKEN is configured.
  {
    let sentHeaders = null;
    globalThis.fetch = async (_url, opts) => {
      sentHeaders = (opts && opts.headers) || {};
      return okJson([]);
    };
    await getGameLeaderboard({
      GAME_API_BASE: "https://example.com",
      GAME_API_TOKEN: "s3cret",
    });
    assert.equal(sentHeaders["X-Red-Egg-Token"], "s3cret");
  }

  // --- limit is clamped to 1..50.
  {
    let calledUrl = null;
    globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return okJson([]);
    };
    await getGameLeaderboard({ GAME_API_BASE: "https://example.com" }, 999);
    assert.ok(calledUrl.endsWith("limit=50"), "clamps oversized limit to 50");
  }

  // --- missing base URL throws.
  {
    await assert.rejects(
      () => getGameLeaderboard({}, 10),
      /GAME_API_BASE is not configured/
    );
  }

  // --- HTTP error throws.
  {
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(
      () => getGameLeaderboard({ GAME_API_BASE: "https://example.com" }),
      /HTTP 502/
    );
  }

  // --- non-array response throws.
  {
    globalThis.fetch = async () => okJson({ oops: true });
    await assert.rejects(
      () => getGameLeaderboard({ GAME_API_BASE: "https://example.com" }),
      /not a JSON array/
    );
  }

  // --- rendering: empty state.
  {
    const blocks = gameLeaderboardBlocks([]);
    const json = JSON.stringify(blocks);
    assert.ok(json.includes("No scores on the board yet"), "shows empty state");
    assert.equal(blocks[0].type, "header");
  }

  // --- rendering: podium badges, thousands formatting, escaping.
  {
    const blocks = gameLeaderboardBlocks([
      { name: "Jacob", score: 12000 },
      { name: "A & B", score: 900 },
      { name: "Three", score: 3 },
      { name: "Four", score: 1 },
    ]);
    const section = blocks.find((b) => b.type === "section");
    const text = section.text.text;
    assert.ok(text.includes("🥇 *Jacob* — 12,000"), "gold + thousands separator");
    assert.ok(text.includes("🥈 *A &amp; B* — 900"), "silver + escaped ampersand");
    assert.ok(text.includes("🥉 *Three* — 3"), "bronze");
    assert.ok(text.includes("4. *Four* — 1"), "numeric rank after the podium");
  }

  // --- unit helpers.
  {
    assert.equal(scoreBadge(0), "🥇");
    assert.equal(scoreBadge(3), "4.");
    assert.equal(formatScore(1000000), "1,000,000");
    assert.equal(formatScore(42), "42");
  }

  console.log("game.test.js: all assertions passed ✅");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
