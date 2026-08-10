// Lightweight functional test for the /dustystick joinall channel enumeration.
//
// No test framework — just `node test/joinall.test.js` (or `npm test`). Stubs
// global fetch to model conversations.list pagination and conversations.join,
// then asserts joinAllPublicChannels paginates, skips channels the bot is
// already in, and reports the right counts.

import assert from "node:assert";
import { joinAllPublicChannels } from "../src/index.js";

const env = { SLACK_BOT_TOKEN: "xoxb-test" };

async function run() {
  // Two pages of conversations.list; one channel already joined (is_member).
  // Only the non-member channels should trigger a conversations.join call.
  {
    const joined = [];
    let listCalls = 0;

    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/conversations.list")) {
        listCalls++;
        const u = new URL(url);
        // page 1 has no cursor; page 2 sends cursor=PAGE2.
        if (u.searchParams.get("cursor") === "PAGE2") {
          return {
            json: async () => ({
              ok: true,
              channels: [{ id: "C3", is_member: false }],
              response_metadata: { next_cursor: "" },
            }),
          };
        }
        return {
          json: async () => ({
            ok: true,
            channels: [
              { id: "C1", is_member: false },
              { id: "C2", is_member: true }, // already in — should be skipped
            ],
            response_metadata: { next_cursor: "PAGE2" },
          }),
        };
      }
      if (String(url).includes("/conversations.join")) {
        joined.push(JSON.parse(opts.body).channel);
        return { json: async () => ({ ok: true }) };
      }
      throw new Error("unexpected fetch: " + url);
    };

    const result = await joinAllPublicChannels(env);
    assert.equal(listCalls, 2, "paginated across both pages");
    assert.equal(result.total, 3, "scanned all three channels");
    assert.equal(result.joined, 2, "joined the two non-member channels");
    assert.deepEqual(joined, ["C1", "C3"], "only non-member channels joined");
  }

  // A `ratelimited` join is skipped without aborting the loop.
  {
    const joined = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/conversations.list")) {
        return {
          json: async () => ({
            ok: true,
            channels: [
              { id: "C1", is_member: false },
              { id: "C2", is_member: false },
            ],
            response_metadata: { next_cursor: "" },
          }),
        };
      }
      if (String(url).includes("/conversations.join")) {
        const channel = JSON.parse(opts.body).channel;
        if (channel === "C1") {
          return { json: async () => ({ ok: false, error: "ratelimited" }) };
        }
        joined.push(channel);
        return { json: async () => ({ ok: true }) };
      }
      throw new Error("unexpected fetch: " + url);
    };

    const result = await joinAllPublicChannels(env);
    assert.equal(result.total, 2, "scanned both channels");
    assert.equal(result.joined, 1, "ratelimited channel not counted as joined");
    assert.deepEqual(joined, ["C2"], "loop continued past the ratelimited join");
  }

  console.log("All joinall tests passed ✅");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
