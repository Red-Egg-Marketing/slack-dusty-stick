// "Dusty Stick of the Week" — weekly prize for whoever accumulated the most
// dusty sticks over the look-back window (a dishonor, naturally).
//
// The "prize" is Lionel Hutz signage — "Works on contingency? No, money down!"
// — copy that reads like a reward but, parsed correctly, is nothing. One is
// drawn at random each time.

import { mentionOrName } from "./format.js";

/**
 * Prizes that sound like something and mean nothing. Slack mrkdwn; the italic
 * footnote (the "…*" reveal) is where the gag lands. Edit freely — it's an array.
 */
export const WEEKLY_PRIZES = [
  "You've won an all-expenses-paid trip!\n_(You pay all the expenses.)_",
  "Redeemable for one (1) prize of equal or lesser value than this message.",
  "Winner receives 100% of the prize pool.\nPrize pool: $0.00.",
  "You've earned a reward you'll never forget.\n_(There is no reward.)_",
  "This certificate entitles the bearer to nothing, and we stand by it.",
  "You've won bragging rights!\n_(Rights void upon bragging.)_",
  "Grand prize: a lifetime supply of exactly what you already have.",
  "Your winnings will be deposited into an account of our choosing.\n_(Ours.)_",
  "As champion, you may keep every Dusty Stick you earned. All of them.",
  "Cash value: see reverse.\n_(There is no reverse.)_",
  "No purchase necessary. No prize, either.",
  "Estimated prize fulfillment: 6\u20138 never.",
  "Free Dusty Stick with every Dusty Stick.\n_(Additional Dusty Stick required.)_",
  "A round of applause!\n_(Applause not included, guaranteed, or real.)_",
];

/** Draw a random non-prize. */
export function randomPrize() {
  return WEEKLY_PRIZES[Math.floor(Math.random() * WEEKLY_PRIZES.length)];
}

/** Start of the look-back window: `days` before `nowMs` (unix epoch ms). */
export function weekWindowStart(nowMs, days = 7) {
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  return nowMs - d * 24 * 60 * 60 * 1000;
}

/**
 * Given weekly count rows (already sorted desc by db.getWeeklyCounts), return
 * the top scorers. Ties all win. { winners: rows[], total: number }.
 */
export function pickWinners(rows) {
  if (!rows || !rows.length) {
    return { winners: [], total: 0 };
  }
  const total = rows[0].total;
  const winners = rows.filter((r) => r.total === total);
  return { winners, total };
}

/** Plain-text fallback / notification line for the announcement. */
export function weeklyWinnerText(winners, total) {
  const names = winners.map((w) => w.receiver_name || w.receiver_id);
  const who = names.length === 1 ? names[0] : names.join(", ");
  return `:dusty_stick: Dusty Stick of the Week: ${who} (${total}). Enjoy the prize.`;
}

/**
 * Block Kit for the weekly announcement. Winners ARE @-mentioned — the public
 * ribbing is the whole point, same as a normal award. `prize` is injectable so
 * tests are deterministic; defaults to a random draw.
 */
export function weeklyWinnerBlocks(winners, total, prize = randomPrize()) {
  const mentions = winners.map((w) => mentionOrName(w.receiver_id, w.receiver_name));
  const stick = total === 1 ? "dusty stick" : "dusty sticks";

  let honoree;
  if (mentions.length === 1) {
    honoree =
      `This week's (dis)honoree: ${mentions[0]} — *${total}* ${stick}. :dusty_stick:`;
  } else {
    const list =
      mentions.slice(0, -1).join(", ") + " & " + mentions[mentions.length - 1];
    honoree =
      `A ${mentions.length}-way tie: ${list} — *${total}* ${stick} each. ` +
      `You all win. :dusty_stick:`;
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🏆 Dusty Stick of the Week", emoji: true },
    },
    { type: "section", text: { type: "mrkdwn", text: honoree } },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*And your prize…*\n${prize}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "New week, clean slate. Try to keep it that way. :dusty_stick:",
        },
      ],
    },
  ];
}

/** Block Kit for a week with no awards (used by the on-demand command only). */
export function weeklyEmptyBlocks() {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🏆 Dusty Stick of the Week", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "Nobody earned a Dusty Stick this week. The prize goes unclaimed — " +
          "which, given the prize, changes nothing.",
      },
    },
  ];
}
