// Lightweight functional test for :dusty_stick: reaction awards.
//
// No test framework — just `node test/reactions.test.js` (or `npm test`).
// Uses a tiny in-memory fake of the D1 API that faithfully models the INSERT
// and the reaction-removal DELETE (matching on source/giver/receiver/channel/
// message_ts), so it exercises the real add/remove/stacking/dedupe logic.

import assert from "node:assert";
import { handleReactionAdded, handleReactionRemoved } from "../src/index.js";

// Minimal D1 stand-in. Rows live in an array; prepare().bind().run() interprets
// the INSERT and reaction DELETE the app actually issues.
function makeFakeDB() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      const stmt = {
        sql: sql.trim(),
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async run() {
          if (this.sql.startsWith("INSERT INTO awards")) {
            const [
              giver_id,
              giver_name,
              receiver_id,
              receiver_name,
              reason,
              source,
              channel_id,
              message_ts,
              created_at,
            ] = this.args;
            rows.push({
              giver_id,
              giver_name,
              receiver_id,
              receiver_name,
              reason,
              source,
              channel_id,
              message_ts,
              created_at,
            });
          } else if (this.sql.startsWith("DELETE FROM awards")) {
            const [giver_id, receiver_id, channel_id, message_ts] = this.args;
            for (let i = rows.length - 1; i >= 0; i--) {
              const r = rows[i];
              if (
                r.source === "reaction" &&
                r.giver_id === giver_id &&
                r.receiver_id === receiver_id &&
                r.channel_id === channel_id &&
                r.message_ts === message_ts
              ) {
                rows.splice(i, 1);
              }
            }
          }
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

// Stub global fetch so chat.getPermalink resolves without network. Returning
// ok:false forces the plain-reason fallback, which is deterministic to assert.
globalThis.fetch = async () => ({ json: async () => ({ ok: false }) });

const env = { DB: null, SLACK_BOT_TOKEN: "xoxb-test" };

function reactionEvent(type, { user, itemUser, channel, ts }) {
  return {
    type,
    user,
    reaction: "dusty_stick",
    item_user: itemUser,
    item: { type: "message", channel, ts },
  };
}

async function run() {
  // 1. A basic add logs one reaction award with the right giver/receiver.
  {
    const db = makeFakeDB();
    env.DB = db;
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    assert.equal(db.rows.length, 1, "one award logged");
    const r = db.rows[0];
    assert.equal(r.giver_id, "UGIVER");
    assert.equal(r.receiver_id, "URECV");
    assert.equal(r.source, "reaction");
    assert.equal(r.channel_id, "C1");
    assert.equal(r.message_ts, "111.1");
    assert.equal(r.reason, "Reacted with :dusty_stick:");
  }

  // 2. Reactions on DIFFERENT messages stack (each is a separate award).
  {
    const db = makeFakeDB();
    env.DB = db;
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "222.2",
      }),
      env
    );
    assert.equal(db.rows.length, 2, "different messages stack");
  }

  // 3. Removal deletes only the matching message's award, leaving others.
  {
    const db = makeFakeDB();
    env.DB = db;
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "222.2",
      }),
      env
    );
    await handleReactionRemoved(
      reactionEvent("reaction_removed", {
        user: "UGIVER",
        itemUser: "URECV",
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    assert.equal(db.rows.length, 1, "only matching award removed");
    assert.equal(db.rows[0].message_ts, "222.2", "the other award survives");
  }

  // 4. Self-awards are ignored on add.
  {
    const db = makeFakeDB();
    env.DB = db;
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "USAME",
        itemUser: "USAME",
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    assert.equal(db.rows.length, 0, "self-award skipped");
  }

  // 5. Missing receiver (item_user absent) is skipped gracefully.
  {
    const db = makeFakeDB();
    env.DB = db;
    await handleReactionAdded(
      reactionEvent("reaction_added", {
        user: "UGIVER",
        itemUser: undefined,
        channel: "C1",
        ts: "111.1",
      }),
      env
    );
    assert.equal(db.rows.length, 0, "no receiver -> skip");
  }

  // 6. Other emoji are ignored.
  {
    const db = makeFakeDB();
    env.DB = db;
    const ev = reactionEvent("reaction_added", {
      user: "UGIVER",
      itemUser: "URECV",
      channel: "C1",
      ts: "111.1",
    });
    ev.reaction = "thumbsup";
    await handleReactionAdded(ev, env);
    assert.equal(db.rows.length, 0, "non-dusty_stick emoji ignored");
  }

  // 7. Reactions on non-message items (e.g. files) are ignored.
  {
    const db = makeFakeDB();
    env.DB = db;
    const ev = reactionEvent("reaction_added", {
      user: "UGIVER",
      itemUser: "URECV",
      channel: "C1",
      ts: "111.1",
    });
    ev.item.type = "file";
    await handleReactionAdded(ev, env);
    assert.equal(db.rows.length, 0, "non-message item ignored");
  }

  console.log("All reaction tests passed ✅");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
