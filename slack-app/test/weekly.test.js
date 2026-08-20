// Functional test for the "Dusty Stick of the Week" logic.
// Run: node test/weekly.test.js  (or npm test).

import assert from "node:assert";
import {
  weekWindowStart,
  pickWinners,
  weeklyWinnerBlocks,
  weeklyWinnerText,
  weeklyEmptyBlocks,
  WEEKLY_PRIZES,
  randomPrize,
} from "../src/weekly.js";

function run() {
  // --- weekWindowStart: subtracts the right number of days, with a fallback.
  {
    const now = 1_000_000_000_000;
    assert.equal(weekWindowStart(now, 7), now - 7 * 86400000);
    assert.equal(weekWindowStart(now, 1), now - 1 * 86400000);
    assert.equal(weekWindowStart(now, 0), now - 7 * 86400000, "0 → default 7");
    assert.equal(weekWindowStart(now, undefined), now - 7 * 86400000);
  }

  // --- pickWinners: empty, single, and tie.
  {
    assert.deepEqual(pickWinners([]), { winners: [], total: 0 });

    const single = pickWinners([
      { receiver_id: "U1", receiver_name: "Alice", total: 4 },
      { receiver_id: "U2", receiver_name: "Bob", total: 2 },
    ]);
    assert.equal(single.total, 4);
    assert.equal(single.winners.length, 1);
    assert.equal(single.winners[0].receiver_id, "U1");

    const tie = pickWinners([
      { receiver_id: "U1", receiver_name: "Alice", total: 3 },
      { receiver_id: "U2", receiver_name: "Bob", total: 3 },
      { receiver_id: "U3", receiver_name: "Cara", total: 1 },
    ]);
    assert.equal(tie.total, 3);
    assert.equal(tie.winners.length, 2, "both top scorers win the tie");
  }

  // --- rendering: single winner, mention + count + injected prize.
  {
    const blocks = weeklyWinnerBlocks(
      [{ receiver_id: "U1", receiver_name: "Alice", total: 4 }],
      4,
      "TEST PRIZE"
    );
    const json = JSON.stringify(blocks);
    assert.ok(json.includes("<@U1>"), "mentions the winner");
    assert.ok(json.includes("*4* dusty sticks"), "shows the count (plural)");
    assert.ok(json.includes("TEST PRIZE"), "renders the injected prize");
    assert.equal(blocks[0].type, "header");
  }

  // --- rendering: singular 'dusty stick' when total is 1.
  {
    const blocks = weeklyWinnerBlocks(
      [{ receiver_id: "U1", receiver_name: "Alice", total: 1 }],
      1,
      "P"
    );
    assert.ok(JSON.stringify(blocks).includes("*1* dusty stick."), "singular noun");
  }

  // --- rendering: tie lists all winners.
  {
    const blocks = weeklyWinnerBlocks(
      [
        { receiver_id: "U1", receiver_name: "Alice", total: 3 },
        { receiver_id: "U2", receiver_name: "Bob", total: 3 },
      ],
      3,
      "P"
    );
    const json = JSON.stringify(blocks);
    assert.ok(json.includes("<@U1>") && json.includes("<@U2>"), "mentions both");
    assert.ok(json.includes("2-way tie"), "labels the tie");
  }

  // --- text fallback.
  {
    assert.ok(
      weeklyWinnerText(
        [{ receiver_id: "U1", receiver_name: "Alice", total: 4 }],
        4
      ).includes("Alice (4)")
    );
  }

  // --- empty state (command-only).
  {
    assert.ok(JSON.stringify(weeklyEmptyBlocks()).includes("goes unclaimed"));
  }

  // --- prizes: picker always returns a defined prize.
  {
    assert.ok(WEEKLY_PRIZES.length > 0);
    for (let i = 0; i < 50; i++) {
      assert.ok(WEEKLY_PRIZES.includes(randomPrize()));
    }
  }

  console.log("weekly.test.js: all assertions passed ✅");
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}
