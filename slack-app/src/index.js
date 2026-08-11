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
import {
  getTacoCounts,
  getWorkspaceMembers,
  buildInverseBoard,
  inverseTacoBlocks,
} from "./notacos.js";
import { getGameLeaderboard, gameLeaderboardBlocks } from "./game.js";

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
          return handleSlashCommand(form, env, ctx);
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

async function handleSlashCommand(form, env, ctx) {
  // Dedicated /notacos command → the inverse HeyTaco board (the No-Taco Club).
  // Separate feature from the Dusty Stick awards; see notacos.js. Both slash
  // commands point at this same Worker URL, told apart by form.command.
  if ((form.command || "").toLowerCase() === "/notacos") {
    return noTacosResponse(form, env, ctx);
  // Dedicated /highscores command → the Red Egg arcade high-score board.
  // This is a wholly separate feature from the Dusty Stick awards (different
  // data source — the WordPress game plugin over HTTP, not D1). Both slash
  // commands point at this same Worker URL and are told apart by form.command.
  if ((form.command || "").toLowerCase() === "/highscores") {
    return await highScoresResponse(form, env);
  }

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

    case "shame-shame-shame":
    case "shame-shame":
    case "shame":
      return await shameResponse(env);

    case "recent":
      return await recentResponse(env);

    case "joinall":
    case "join":
    case "join-all":
      return joinAllResponse(form, env, ctx);

    default:
      // Anything else is treated as an award: "<@receiver> <reason>".
      return await giveAwardResponse(text, giverId, giverName, channelId, env);
  }
}



// ---------------------------------------------------------------------------
// /notacos — the No-Taco Club (inverse HeyTaco leaderboard)
// ---------------------------------------------------------------------------

/**
 * Handle /notacos. Building the board needs a HeyTaco fetch plus a (possibly
 * paginated) Slack users.list, which can approach Slack's 3-second slash
 * window — so we ACK immediately with an ephemeral "counting…" and post the
 * finished board in-channel via the slash command's response_url (same
 * deferred pattern as joinall). `/notacos help` shows usage.
 */
function noTacosResponse(form, env, ctx) {
  const text = (form.text || "").trim().toLowerCase();
  if (text === "help") {
    return jsonResponse(noTacosHelp());
  }

  const responseUrl = form.response_url || null;
  const days = Number(env.HEYTACO_DAYS) || undefined; // undefined → module default (30)

  runInBackground(
    ctx,
    (async () => {
      try {
        // Fetch both sources in parallel; join happens locally.
        const [counts, members] = await Promise.all([
          getTacoCounts(env, days),
          getWorkspaceMembers(env),
        ]);
        const { rows, extraZeros } = buildInverseBoard(members, counts, 15);
        await postToResponseUrl(responseUrl, {
          response_type: "in_channel",
          blocks: inverseTacoBlocks(rows, extraZeros),
          text: "The No-Taco Club",
        });
      } catch (err) {
        console.error(
          "notacos failed:",
          err && err.stack ? err.stack : err
        );
        await postToResponseUrl(responseUrl, {
          response_type: "ephemeral",
          text: "😵 Couldn't build the No-Taco Club right now. Check HEYTACO_TEAM_ID and the Worker logs.",
        });
      }
    })()
  );

  return jsonResponse({
    response_type: "ephemeral",
    text: "Counting clean plates… :taco:",
  });
}

function noTacosHelp() {
// /highscores — Red Egg arcade high-score board
// ---------------------------------------------------------------------------

/**
 * Handle the /highscores slash command. Fetches the top scores from the
 * WordPress game plugin and posts them to the channel as a Block Kit board.
 * `/highscores help` shows usage. Any failure falls back to a friendly
 * ephemeral message (the underlying error is logged for the operator).
 */
async function highScoresResponse(form, env) {
  const text = (form.text || "").trim().toLowerCase();

  if (text === "help") {
    return jsonResponse(highScoresHelp());
  }

  try {
    const rows = await getGameLeaderboard(env, 10);
    return jsonResponse({
      response_type: "in_channel",
      blocks: gameLeaderboardBlocks(rows),
      text: ":fire: Red Egg High Scores",
    });
  } catch (err) {
    console.error(
      "highscores failed:",
      err && err.stack ? err.stack : err
    );
    return jsonResponse({
      response_type: "ephemeral",
      text: "😵 Couldn't reach the high-score board right now. Try again in a moment.",
    });
  }
}

function highScoresHelp() {
  return {
    response_type: "ephemeral",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "The No-Taco Club", emoji: true },
        text: { type: "plain_text", text: "Red Egg High Scores", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            ":taco: The inverse leaderboard — who's received the *fewest* tacos.",
            "",
            "• `/notacos` — show the clean-plate board",
            "• `/notacos help` — show this message",
            "",
            "_Names are listed without @-mentions, so nobody gets pinged._",
            ":video_game: The Red Egg arcade high-score board.",
            "",
            "• `/highscores` — show the top 10 scores",
            "• `/highscores help` — show this message",
          ].join("\n"),
        },
      },
    ],
    text: "The No-Taco Club help",
    text: "Red Egg High Scores help",
  };
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
    return jsonResponse(usageResponse("You need to mention who's earned an L."));
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
          text: `:dusty_stick: *Dusty Stick awarded* :dusty_stick:\n${giver} just dusted ${receiver}. Oof — you played yourself.`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `_"${escapeSlackText(reason)}"_` },
      },
    ],
    // Fallback text for notifications / clients that don't render blocks.
    text: `:dusty_stick: ${giverName} handed ${mention.name} a Dusty Stick: "${reason}" — oof.`,
  });
}

async function shameResponse(env) {
  const rows = await getLeaderboard(env.DB, 15);

  if (rows.length === 0) {
    return jsonResponse({
      response_type: "ephemeral",
      text: "Nobody to shame yet — the board's empty. Hand one out with `/dustystick @someone <reason>` :dusty_stick:",
    });
  }

  const top = rows[0];
  const loser = mentionOrName(top.receiver_id, top.receiver_name);
  const plainName = top.receiver_name || top.receiver_id;
  const count = top.total;

  return jsonResponse({
    response_type: "in_channel",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:dusty_stick: *Shame, shame, shame* :dusty_stick:\n` +
            `${loser} is running away with it — *${count}* dusty stick${count === 1 ? "" : "s"}. ` +
            `Maybe take a break from Slack.`,
        },
      },
      {
        type: "image",
        image_url: randomShameGif(),
        alt_text: "Shame, shame, shame",
      },
      // { type: "divider" },
      // ...leaderboardBlocks(rows, { header: false }),
    ],
    text: `Wow, ${plainName} — maybe you should take a break from Slack.`,
  });
}


async function leaderboardResponse(env) {
  const rows = await getLeaderboard(env.DB, 15);
  return jsonResponse({
    response_type: "in_channel",
    blocks: leaderboardBlocks(rows),
    text: ":dusty_stick: Dusty Stick Hall of Shame",
  });
}

async function recentResponse(env) {
  const rows = await getRecent(env.DB, 10);

  if (rows.length === 0) {
    return jsonResponse({
      response_type: "ephemeral",
      text: "No dustings yet. Nobody's earned an L… so far. Hand one out with `/dustystick @someone <reason>` :dusty_stick:",
    });
  }

  const lines = rows.map((r) => {
    const giver = mentionOrName(r.giver_id, r.giver_name);
    const receiver = mentionOrName(r.receiver_id, r.receiver_name);
    const when = relativeTime(r.created_at);
    return `:dusty_stick: ${giver} → ${receiver}: _"${escapeSlackText(r.reason)}"_  · _${when}_`;
  });

  return jsonResponse({
    response_type: "ephemeral",
    blocks: [
      {
        // Custom emoji don't render reliably in a plain_text header, so the
        // :dusty_stick: appears in the mrkdwn lines below instead.
        type: "header",
        text: { type: "plain_text", text: "Recent Dustings", emoji: true },
      },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ],
    text: "Recent Dustings",
  });
}

/**
 * Admin backfill: add the bot to every public channel so it receives reaction
 * events there (Slack only delivers reactions for channels the bot is in).
 *
 * Enumerating and joining channels can easily exceed Slack's 3-second slash
 * window, so we ACK immediately with an ephemeral "on it" and do the join loop
 * in the background (ctx.waitUntil), reporting completion back via the slash
 * command's response_url. Idempotent: joining an already-joined channel is a
 * no-op, and channels the bot is already a member of are skipped up front.
 */
function joinAllResponse(form, env, ctx) {
  const responseUrl = form.response_url || null;

  runInBackground(
    ctx,
    (async () => {
      try {
        const { joined, total } = await joinAllPublicChannels(env);
        await postToResponseUrl(responseUrl, {
          response_type: "ephemeral",
          text:
            `Joined ${joined} public channel${joined === 1 ? "" : "s"} ` +
            `(scanned ${total}). New public channels are joined automatically.`,
        });
      } catch (err) {
        console.error(
          "joinall failed:",
          err && err.stack ? err.stack : err
        );
        await postToResponseUrl(responseUrl, {
          response_type: "ephemeral",
          text: "Ran into a problem joining channels. Check the Worker logs.",
        });
      }
    })()
  );

  return jsonResponse({
    response_type: "ephemeral",
    text: "On it — joining public channels…",
  });
}

function helpResponse() {
  return {
    response_type: "ephemeral",
    blocks: [
      {
        // :dusty_stick: kept out of the plain_text header (renders literally
        // there); it leads the mrkdwn section below where it renders correctly.
        type: "header",
        text: { type: "plain_text", text: "Dusty Stick Awards", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            ":dusty_stick: The team's booby prize — hand someone a Dusty Stick when they earn an L.",
            "",
            "• `/dustystick @person <reason>` — give someone a dusty stick",
            "• `/dustystick leaderboard` — the hall of shame (who's collected the most)",
            "• `/dustystick shame` — the one person who currently has the most",
            "• `/dustystick recent` — the last 10 dustings",
            "• `/dustystick joinall` — add the bot to all public channels",
            "• `/dustystick help` — show this message",
            "",
            "_`joinall` may post a one-time \"added to channel\" notice in each channel it joins._",
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
      "_Example:_ `/dustystick @jane replied-all to the whole company`",
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
    } else if (event.type === "channel_created") {
      // Auto-join newly created public channels so the bot starts receiving
      // their reaction events without an admin having to /invite it.
      await runInBackground(ctx, handleChannelCreated(event, env));
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


// Publicly reachable .gif URLs — Slack fetches these server-side.
const SHAME_GIFS = [
  "https://dusty-stick.web-026.workers.dev/imgs/shame-1.gif",
  "https://dusty-stick.web-026.workers.dev/imgs/shame-2.gif",
  "https://dusty-stick.web-026.workers.dev/imgs/shame-3.gif",
];

/** Pick a random shame gif. */
function randomShameGif() {
  return SHAME_GIFS[Math.floor(Math.random() * SHAME_GIFS.length)];
}
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

// ---------------------------------------------------------------------------
// Auto-join channels
// ---------------------------------------------------------------------------

/**
 * A public channel was created. Join it so the bot receives its reaction
 * events. `channel_created` delivers the new channel as an object with an `id`.
 * Best-effort; never throws (runs in the background after we've ACKed Slack).
 */
export async function handleChannelCreated(event, env) {
  const channelId = event.channel && event.channel.id;
  if (!channelId) return;
  await joinChannel(channelId, env);
}

/**
 * Enumerate every public channel and join the ones the bot isn't already in.
 * Returns { total, joined }. Idempotent and safe to run repeatedly.
 */
export async function joinAllPublicChannels(env) {
  const channels = await listPublicChannels(env);
  let joined = 0;
  for (const channel of channels) {
    if (channel.is_member) continue; // already in — skip the API call.
    const ok = await joinChannel(channel.id, env);
    if (ok) joined++;
  }
  return { total: channels.length, joined };
}

/**
 * List all non-archived public channels via conversations.list, following the
 * `next_cursor` pagination until exhausted. Returns an array of channel objects
 * (each has at least `id` and `is_member`). Never throws — logs and returns
 * whatever it gathered on error.
 */
async function listPublicChannels(env) {
  const channels = [];
  let cursor = "";
  try {
    // Bound the loop defensively so a misbehaving cursor can't spin forever.
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(
        "https://slack.com/api/conversations.list?" + params,
        { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        console.error("conversations.list failed:", JSON.stringify(data));
        break;
      }

      for (const channel of data.channels || []) {
        channels.push(channel);
      }

      cursor = data.response_metadata && data.response_metadata.next_cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.error(
      "conversations.list error:",
      err && err.stack ? err.stack : err
    );
  }
  return channels;
}

/**
 * Join a single channel via conversations.join (bot token). Returns true on
 * success, false otherwise. Joining an already-joined channel is a no-op that
 * Slack reports as ok. On `ratelimited` we skip the channel and keep going so
 * one throttled call never aborts the whole loop. Never throws.
 */
async function joinChannel(channelId, env) {
  try {
    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return true;
    if (data.error === "ratelimited") {
      console.error(`conversations.join ratelimited for ${channelId}; skipping`);
      return false;
    }
    console.error(
      `conversations.join failed for ${channelId}:`,
      JSON.stringify(data)
    );
    return false;
  } catch (err) {
    console.error(
      `conversations.join error for ${channelId}:`,
      err && err.stack ? err.stack : err
    );
    return false;
  }
}

/**
 * POST a JSON payload to a slash command's response_url to send a delayed
 * follow-up message to the invoking user. Best-effort; never throws.
 */
async function postToResponseUrl(responseUrl, payload) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(
      "response_url post error:",
      err && err.stack ? err.stack : err
    );
  }
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
      // :dusty_stick: stays out of the plain_text header (renders literally
      // there); it shows in the mrkdwn context line and how-to section below.
      type: "header",
      text: { type: "plain_text", text: "Dusty Stick Awards", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":dusty_stick: The team's booby prize — a dubious honor for anyone who earns an L",
        },
      ],
    },
    ...leaderboardBlocks(rows, { header: false }),
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*How to use*",
          "• `/dustystick @person <reason>` — give someone a Dusty Stick when they earn an L :dusty_stick:",
          "• `/dustystick leaderboard` — the full hall of shame",
          "• `/dustystick recent` — the latest dustings",
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
