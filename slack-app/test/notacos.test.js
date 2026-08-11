// Lightweight functional test for /notacos (the No-Taco Club).
//
// No test framework — just `node test/notacos.test.js` (or `npm test`). Stubs
// global fetch to model both the HeyTaco leaderboard API and Slack users.list,
// and asserts count parsing, roster filtering, the inverse (fewest-first) join
// with zeros, the "…and N more" overflow, and Block Kit rendering.

import assert from "node:assert";
import {
  getTacoCounts,
  getWorkspaceMembers,
  buildInverseBoard,
  inverseTacoBlocks,
  NO_TACO_SLOGANS,
  randomSlogan,
} from "../src/notacos.js";

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

async function run() {
  // --- getTacoCounts: builds the URL, parses string counts, keys by user id.
  {
    let calledUrl = null;
    globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return okJson({
        leaderboard: [
          { received_by_id: "U1", username: "alice", count: "5" },
          { received_by_id: "U2", username: "bob", count: "2" },
          { received_by_id: "U3", username: "carol", count: "bad" }, // → 0
        ],
      });
    };

    const counts = await getTacoCounts({ HEYTACO_TEAM_ID: "T123" }, 30);
    assert.equal(
      calledUrl,
      "https://www.heytaco.chat/api/v1/json/leaderboard/T123?days=30",
      "builds the HeyTaco leaderboard URL with team id + days"
    );
    assert.equal(counts.get("U1"), 5);
    assert.equal(counts.get("U2"), 2);
    assert.equal(counts.get("U3"), 0, "non-numeric count coerces to 0");
  }

  // --- getTacoCounts: missing team id and bad shape throw.
  {
    await assert.rejects(() => getTacoCounts({}, 30), /HEYTACO_TEAM_ID is not configured/);
    globalThis.fetch = async () => okJson({ not_a_leaderboard: true });
    await assert.rejects(
      () => getTacoCounts({ HEYTACO_TEAM_ID: "T1" }),
      /missing a leaderboard array/
    );
  }

  // --- getWorkspaceMembers: paginates and filters bots/deleted/Slackbot.
  {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      const u = new URL(String(url));
      if (u.searchParams.get("cursor") === "PAGE2") {
        return okJson({
          ok: true,
          members: [
            { id: "U4", name: "dave", profile: { real_name: "Dave" } },
            { id: "USLACKBOT", name: "slackbot", profile: {} }, // excluded
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      return okJson({
        ok: true,
        members: [
          { id: "U1", profile: { display_name: "Alice A" } },
          { id: "U2", name: "bob", profile: { real_name: "Bob B" } },
          { id: "B1", is_bot: true, profile: {} }, // excluded
          { id: "U9", deleted: true, profile: {} }, // excluded
        ],
        response_metadata: { next_cursor: "PAGE2" },
      });
    };

    const members = await getWorkspaceMembers({ SLACK_BOT_TOKEN: "xoxb-test" });
    assert.equal(calls, 2, "follows pagination cursor");
    const ids = members.map((m) => m.id).sort();
    assert.deepEqual(ids, ["U1", "U2", "U4"], "bots, deleted, Slackbot excluded");
    const alice = members.find((m) => m.id === "U1");
    assert.equal(alice.name, "Alice A", "prefers display_name");
    const bob = members.find((m) => m.id === "U2");
    assert.equal(bob.name, "Bob B", "falls back to real_name");
  }

  // --- getWorkspaceMembers: Slack API error throws (e.g. missing scope).
  {
    globalThis.fetch = async () => okJson({ ok: false, error: "missing_scope" });
    await assert.rejects(
      () => getWorkspaceMembers({ SLACK_BOT_TOKEN: "x" }),
      /users.list failed: missing_scope/
    );
  }

  // --- buildInverseBoard: zeros float to the top, ascending, then alpha.
  {
    const members = [
      { id: "U1", name: "Alice" },
      { id: "U2", name: "Bob" },
      { id: "U3", name: "Carol" },
      { id: "U4", name: "Dave" },
    ];
    const counts = new Map([
      ["U1", 5],
      ["U2", 0], // absent-from-taco-data equivalent, explicit 0
      // U3, U4 absent → 0
    ]);

    const { rows, extraZeros } = buildInverseBoard(members, counts, 2);
    assert.deepEqual(
      rows.map((r) => `${r.name}:${r.count}`),
      ["Bob:0", "Carol:0"],
      "fewest first, alphabetical among ties, limited to 2"
    );
    assert.equal(extraZeros, 1, "Dave is a 4th person at 0 not shown → extraZeros=1");
  }

  // --- rendering: podium sparkle for zeros, escaping, overflow line.
  {
    const { rows, extraZeros } = buildInverseBoard(
      [
        { id: "U1", name: "A & B" },
        { id: "U2", name: "Zed" },
      ],
      new Map([["U2", 3]]),
      5
    );
    const blocks = inverseTacoBlocks(rows, extraZeros);
    const section = blocks.find((b) => b.type === "section");
    const t = section.text.text;
    assert.ok(t.includes("✨ *A &amp; B* — 0 :taco:"), "zero gets sparkle + escaped name");
    assert.ok(t.includes("• *Zed* — 3 :taco:"), "non-zero gets a bullet");
    // No mentions — must never contain <@…> tokens (avoids pinging people).
    assert.ok(!/<@/.test(JSON.stringify(blocks)), "renders names, never @-mentions");
  }

  // --- rendering: empty roster shows the clean-plate empty state.
  {
    const blocks = inverseTacoBlocks([], 0);
    assert.ok(JSON.stringify(blocks).includes("not a clean plate in sight"));
  }

  // --- slogans: picker returns a member; a passed slogan renders in context.
  {
    assert.ok(NO_TACO_SLOGANS.length > 0, "there are slogans");
    for (let i = 0; i < 50; i++) {
      assert.ok(
        NO_TACO_SLOGANS.includes(randomSlogan()),
        "randomSlogan always returns a defined slogan"
      );
    }
    const blocks = inverseTacoBlocks(
      [{ id: "U1", name: "Alice", count: 0 }],
      0,
      "Real work doesn't come with tacos."
    );
    const context = blocks.find((b) => b.type === "context");
    assert.ok(
      context.elements[0].text.includes("Real work doesn't come with tacos."),
      "the supplied slogan renders in the context line"
    );
  }

  console.log("notacos.test.js: all assertions passed ✅");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
