// Dusty Stick Awards — Cloudflare Worker + D1 Slack app.
//
// Single entry point. It handles two kinds of inbound Slack traffic, both of
// which arrive as POSTs to this Worker's URL:
//
//   1. Slash commands  (/dustystick ...) — content-type
//      application/x-www-form-urlencoded. We dispatch on the presence of a
//      `command` field in the parsed form.
//
//   2. Events API      (app_home_opened, reaction_added, reaction_removed,
//      url_verification) — content-type application/json. We dispatch on the
//      JSON `type` field. Reacting with :dusty_stick: on a message awards a
//      dusty stick; removing the reaction revokes it.
//
// Both are distinguished by content-type / payload shape, so a single request
// URL works for everything. (You may point both the slash-command URL and the
// Events request URL at the same deployed Worker URL.)
//
// Every request except the Events url_verification handshake is verified
// against the Slack signing secret before we do anything else.

import { verifySlackRequest } from "./verify.js";
import {
  insertAward,
  deleteReactionAward,
  getLeaderboard,
  getRecent,
} from "./db.js";
import {
  escapeSlackText,
  relativeTime,
  leaderboardBlocks,
  mentionOrName,
} from "./format.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Dusty Stick Awards Worker is running. POST only.", {
        status: 200,
      });
    }

    // Read the raw body ONCE, before parsing — needed for both the signature
    // check and form/JSON parsing.
    const rawBody = await request.text();

    // Verify the Slack signature on every inbound request.
    const authentic = await verifySlackRequest(
      request,
      rawBody,
      env.SLACK_SIGNING_SECRET
    );
    if (!authentic) {
      return new Response("Invalid Slack signature", { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";

    try {
      if (contentType.includes("application/json")) {
        // Events API (url_verification / event_callback).
        const payload = JSON.parse(rawBody);
        return await handleEvent(payload, env, ctx);
      }

      if (contentType.includes("application/x-www-form-urlencoded")) {
        // Slash command.
        const form = parseForm(rawBody);
        if (form.command) {
          return handleSlashCommand(form, env);
        }
      }

      return new Response("Unsupported request", { status: 400 });
    } catch (err) {
      // Never leak internals to Slack; log for the operator.
      console.error("Handler error:", err && err.stack ? err.stack : err);
      return jsonResponse({
        response_type: "ephemeral",
        text: "😵 Something went wrong handling that. Try again in a moment.",
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

async function handleSlashCommand(form, env) {
  const text = (form.text || "").trim();
  const giverId = form.user_id || "";
  const giverName = form.user_name || "someone";
  const channelId = form.channel_id || null;

  // First whitespace-delimited word is the subcommand (case-insensitive).
  const firstWord = text.split(/\s+/)[0]?.toLowerCase() || "";

  switch (firstWord) {
    case "":
    case "help":
      return jsonResponse(helpResponse());

    case "leaderboard":
    case "board":
    case "top":
      return await leaderboardResponse(env);

    case "recent":
      return await recentResponse(env);

    default:
      // Anything else is treated as an award: "<@receiver> <reason>".
      return await giveAwardResponse(text, giverId, giverName, channelId, env);
  }
}

/**
 * Parse and record an award. The text should look like:
 *   <@U12345|username> crushed the deadline
 * (Slack sends the escaped mention token when "Escape channels, users, and
 * links" is enabled on the slash command.)
 */
async function giveAwardResponse(text, giverId, giverName, channelId, env) {
  const mention = parseUserMention(text);

  if (!mention) {
    return jsonResponse(usageResponse("You need to mention who earned it."));
  }

  // The reason is everything after the mention token.
  const reason = text.slice(mention.endIndex).trim();
  if (!reason) {
    return jsonResponse(usageResponse("You need to give a reason."));
  }

  await insertAward(env.DB, {
    giverId,
    giverName,
    receiverId: mention.id,
    receiverName: mention.name,
    reason,
    source: "command",
    channelId,
    messageTs: null,
  });

  const giver = mentionOrName(giverId, giverName);
  const receiver = mentionOrName(mention.id, mention.name);

  return jsonResponse({
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🌵🏆 *Dusty Stick Award!* 🏆🌵\n${giver} just handed a dusty stick to ${receiver}.`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `_"${escapeSlackText(reason)}"_` },
      },
    ],
    // Fallback text for notifications / clients that don't render blocks.
    text: `🌵🏆 ${giverName} gave a Dusty Stick Award to ${mention.name}: "${reason}"`,
  });
}

async function leaderboardResponse(env) {
  const rows = await getLeaderboard(env.DB, 15);
  return jsonResponse({
    response_type: "in_channel",
    blocks: leaderboardBlocks(rows),
    text: "🌵🏆 Dusty Stick Leaderboard",
  });
}

async function recentResponse(env) {
  const rows = await getRecent(env.DB, 10);

  if (rows.length === 0) {
    return jsonResponse({
      response_type: "ephemeral",
      text: "No dusty sticks awarded yet. Give one with `/dustystick @someone <reason>` 🌵",
    });
  }

  const lines = rows.map((r) => {
    const giver = mentionOrName(r.giver_id, r.giver_name);
    const receiver = mentionOrName(r.receiver_id, r.receiver_name);
    const when = relativeTime(r.created_at);
    return `🌵 ${giver} → ${receiver}: _"${escapeSlackText(r.reason)}"_  · _${when}_`;
  });

  return jsonResponse({
    response_type: "ephemeral",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🌵 Recent Dusty Sticks", emoji: true },
      },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ],
    text: "Recent Dusty Sticks",
  });
}

function helpResponse() {
  return {
    response_type: "ephemeral",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🌵🏆 Dusty Stick Awards", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "Give and track dusty sticks around the team.",
            "",
            "• `/dustystick @person <reason>` — award a dusty stick",
            "• `/dustystick leaderboard` — see who's collected the most",
            "• `/dustystick recent` — the last 10 awards",
            "• `/dustystick help` — show this message",
          ].join("\n"),
        },
      },
    ],
    text: "Dusty Stick Awards help",
  };
}

function usageResponse(problem) {
  return {
    response_type: "ephemeral",
    text: [
      problem ? `⚠️ ${problem}` : "⚠️ That didn't look right.",
      "",
      "*Usage:* `/dustystick @person <reason>`",
      "_Example:_ `/dustystick @jane crushed the Q3 deadline`",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Events API
// ---------------------------------------------------------------------------

async function handleEvent(payload, env, ctx) {
  // URL verification handshake: echo the challenge back.
  if (payload.type === "url_verification") {
    return jsonResponse({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback" && payload.event) {
    const event = payload.event;

    if (event.type === "app_home_opened") {
      // Publish the Home tab. Do it in the background so we can ACK Slack
      // immediately (Slack expects a 200 within 3 seconds).
      await runInBackground(ctx, publishHome(event.user, env));
    } else if (event.type === "reaction_added") {
      await runInBackground(ctx, handleReactionAdded(event, env));
    } else if (event.type === "reaction_removed") {
      await runInBackground(ctx, handleReactionRemoved(event, env));
    }
  }

  // Always 200 quickly for events.
  return new Response("", { status: 200 });
}

/**
 * Run background work after ACKing Slack. Prefers ctx.waitUntil so the 200 is
 * sent immediately (Slack expects a reply within 3 seconds); falls back to
 * awaiting when no execution context is available (e.g. tests).
 */
async function runInBackground(ctx, work) {
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
    return;
  }
  // No execution context (e.g. local dev / tests) — await so the work finishes.
  await work;
}

// ---------------------------------------------------------------------------
// Reaction awards
// ---------------------------------------------------------------------------

// The custom emoji whose reaction grants a dusty stick.
const REACTION_EMOJI = "dusty_stick";

/**
 * Someone reacted with :dusty_stick:. Log an award where the giver is the
 * reactor and the receiver is the author of the reacted-to message.
 */
export async function handleReactionAdded(event, env) {
  if (!isDustyStickMessageReaction(event)) return;

  const giverId = event.user;
  const receiverId = event.item_user;

  // No receiver (item_user can be absent, e.g. some bot/app messages) — skip.
  if (!receiverId) return;

  // Can't award yourself.
  if (giverId === receiverId) return;

  const channelId = event.item.channel;
  const messageTs = event.item.ts;
  const reason = await buildReactionReason(channelId, messageTs, env);

  await insertAward(env.DB, {
    giverId,
    giverName: giverId,
    receiverId,
    receiverName: receiverId,
    reason,
    source: "reaction",
    channelId,
    messageTs,
  });
}

/**
 * Someone removed their :dusty_stick: reaction. Revoke the matching award.
 * Slack allows only one reaction of a given emoji per user per message, so the
 * (source, giver, receiver, channel, ts) tuple uniquely identifies the row.
 */
export async function handleReactionRemoved(event, env) {
  if (!isDustyStickMessageReaction(event)) return;

  const giverId = event.user;
  const receiverId = event.item_user;
  if (!receiverId) return;
  if (giverId === receiverId) return;

  await deleteReactionAward(env.DB, {
    giverId,
    receiverId,
    channelId: event.item.channel,
    messageTs: event.item.ts,
  });
}

/** True only for a :dusty_stick: reaction on a message (not a file, etc.). */
function isDustyStickMessageReaction(event) {
  return (
    event.reaction === REACTION_EMOJI &&
    event.item &&
    event.item.type === "message"
  );
}

/**
 * Build the stored reason for a reaction award. Best-effort: try to link to the
 * reacted-to message via chat.getPermalink; fall back to a plain reason if the
 * lookup fails so a permalink error never blocks award logging.
 */
async function buildReactionReason(channelId, messageTs, env) {
  const permalink = await getPermalink(channelId, messageTs, env);
  if (permalink) {
    return `Reacted with :dusty_stick: on <${permalink}|a message>`;
  }
  return "Reacted with :dusty_stick:";
}

/**
 * Fetch a permalink to a message via chat.getPermalink. Returns the URL string
 * or null on any failure (the bot must be in the channel; no extra scope
 * needed). Never throws.
 */
async function getPermalink(channelId, messageTs, env) {
  try {
    const url =
      "https://slack.com/api/chat.getPermalink?" +
      new URLSearchParams({ channel: channelId, message_ts: messageTs });
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.permalink) {
      return data.permalink;
    }
    console.error("chat.getPermalink failed:", JSON.stringify(data));
    return null;
  } catch (err) {
    console.error(
      "chat.getPermalink error:",
      err && err.stack ? err.stack : err
    );
    return null;
  }
}

/** Build and publish the App Home view for a given user. */
async function publishHome(userId, env) {
  const rows = await getLeaderboard(env.DB, 15);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🌵🏆 Dusty Stick Awards", emoji: true },
    },
    ...leaderboardBlocks(rows, { header: false }),
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*How to use*",
          "• `/dustystick @person <reason>` — award a dusty stick 🌵",
          "• `/dustystick leaderboard` — full standings",
          "• `/dustystick recent` — the latest awards",
        ].join("\n"),
      },
    },
  ];

  const view = { type: "home", blocks };

  const res = await fetch("https://slack.com/api/views.publish", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ user_id: userId, view }),
  });

  // Surface Slack API errors in the logs for debugging.
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("views.publish failed:", JSON.stringify(data));
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Parse an application/x-www-form-urlencoded body into a plain object. */
function parseForm(rawBody) {
  const params = new URLSearchParams(rawBody);
  const out = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

/**
 * Parse the first Slack user mention token from text.
 * Enabled "Escape channels, users, and links" sends: <@U12345|username>
 * (the |username part is optional). Returns { id, name, endIndex } or null.
 */
function parseUserMention(text) {
  const match = text.match(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/);
  if (!match) return null;
  const id = match[1];
  const name = (match[2] || "").trim() || id;
  return {
    id,
    name,
    endIndex: match.index + match[0].length,
  };
}

/** JSON response helper (200) for Slack command / event replies. */
function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
