# Dusty Stick Awards — Slack App

A Slack app for the Red Egg Marketing team to give and track **Dusty Stick Awards** — a
tongue-in-cheek *negative* award, a Razzie-style dishonor. A Dusty Stick is the team's
booby prize: you get one for a goof, a fail, an L, or a facepalm moment. It's all
good-natured ribbing, and the leaderboard is a **hall of shame** where the person on top
has collected the *most* dusty sticks, not the fewest.
It runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed by
[Cloudflare D1](https://developers.cloudflare.com/d1/) (serverless SQLite). No external
database server, no build step beyond Wrangler.

> Looking for the browser-only version? See `../index.html` in the repo root. This
> `slack-app/` directory is the standalone Slack + Cloudflare implementation.

## What it does

- **`/dustystick @person <reason>`** — hand someone a dusty stick when they earn an L.
  Posts a playful, mock-commiseration in-channel announcement with giver, receiver, and reason.
- **`/dustystick leaderboard`** (also `board` / `top`) — the **hall of shame**, ranked by
  dusty sticks collected (top = biggest offender).
- **`/dustystick recent`** — the last 10 dustings.
- **`/dustystick help`** (or empty/unknown) — usage help.
- **`:dusty_stick:` reaction** — reacting with the custom `:dusty_stick:` emoji on any
  message awards a dusty stick to the message's author (the reactor is the giver). Each
  reacted-to message counts as a separate award (they stack). Removing the reaction
  revokes that award. You can't award yourself (a reaction on your own message is ignored).
- **App Home tab** — shows the leaderboard plus a short "how to use" section, refreshed
  each time someone opens the app's Home tab.
- **`/dustystick joinall`** — adds the bot to every public channel so it can see
  `:dusty_stick:` reactions there. Slack only delivers reaction events for channels the
  bot is a member of, so this is a one-time backfill; run it once after installing. It's
  idempotent (already-joined channels are skipped) and may post a one-time "added to
  channel" notice in each channel it joins. New public channels are joined automatically
  going forward (via the `channel_created` event). **Private** channels still need a manual
  `/invite @Dusty Stick Awards` — bots cannot self-join private channels.

## Architecture at a glance

- One Worker URL handles everything. Slack sends:
  - **Slash commands** as `application/x-www-form-urlencoded` POSTs → dispatched when a
    `command` field is present.
  - **Events API** callbacks (`url_verification`, `app_home_opened`,
    `reaction_added`, `reaction_removed`, `channel_created`) as `application/json` POSTs →
    dispatched on the JSON `type` field.
  So both the **slash command Request URL** and the **Events Request URL** point at the
  *same* deployed Worker URL (the root `/`).
- **Signature verification** runs on every request: HMAC-SHA256 over
  `v0:{timestamp}:{raw_body}` using `SLACK_SIGNING_SECRET`, constant-time compared to
  `X-Slack-Signature`, rejecting timestamps older than 5 minutes (401 on failure). This
  applies to the reaction events too.
- The App Home is published with `views.publish` using the bot token.
- Reaction events are ACKed with a 200 immediately; the D1 write and the
  `chat.getPermalink` lookup (used to build the award's reason) run in `ctx.waitUntil`.
- `/dustystick joinall` and the `channel_created` auto-join both ACK Slack immediately and
  do the `conversations.list` / `conversations.join` work in `ctx.waitUntil`. `joinall`
  reports completion back to the invoking user via the slash command's `response_url`.

---

## Setup checklist

### 1. Prereqs

```bash
# from this directory (slack-app/)
node --version        # v18+ recommended
npm i                 # installs wrangler (dev dependency)
npx wrangler login     # authenticate Wrangler with your Cloudflare account
```

### 2. Create the D1 database and load the schema

```bash
npx wrangler d1 create dusty-stick
```

Copy the `database_id` it prints and paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`. Then create the table + indexes:

```bash
npm run db:init        # wrangler d1 execute dusty-stick --file=./schema.sql --remote
```

> **Upgrading an existing database?** If you created the D1 database *before* reaction
> support was added, its `awards` table is missing the `source`, `channel_id`, and
> `message_ts` columns. Run the one-time migration instead of re-running `db:init`:
>
> ```bash
> npm run db:migrate   # wrangler d1 execute dusty-stick --file=./migrations/0001_add_reaction_support.sql --remote
> ```
>
> SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS`, so run the migration only
> once — on an already-migrated DB it errors with "duplicate column name", which is safe
> to ignore. Fresh installs get everything from `db:init` and should *not* run it.

### 3. Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**, pick
your workspace, and paste the manifest below. (You can also configure everything by hand;
the manifest just does it in one shot.)

**Replace `https://YOUR-WORKER-URL.workers.dev` with your deployed Worker URL** (you'll
have it after step 5 — you can paste a placeholder now and update the two Request URLs
after deploying).

```yaml
display_information:
  name: Dusty Stick Awards
  description: The team's booby prize — hand out and track Dusty Stick Awards :dusty_stick:
  background_color: "#8a6d3b"
features:
  bot_user:
    display_name: dustystick
    always_online: true
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: false
  slash_commands:
    - command: /dustystick
      url: https://YOUR-WORKER-URL.workers.dev/
      description: Hand out or track Dusty Stick Awards (the team booby prize)
      usage_hint: "@person <reason>  |  leaderboard  |  recent  |  help"
      # IMPORTANT: this must be true so Slack sends <@U123|name> mention tokens.
      should_escape: true
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - users:read
      - reactions:read
      - channels:join
      - channels:read
settings:
  event_subscriptions:
    request_url: https://YOUR-WORKER-URL.workers.dev/
    bot_events:
      - app_home_opened
      - reaction_added
      - reaction_removed
      - channel_created
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

**Request URLs:** both the slash command `url` and the Events `request_url` point to the
Worker's root URL. The Worker distinguishes them by content-type / payload shape.

**Required bot scopes:** `commands`, `chat:write`, `users:read`, `reactions:read`,
`channels:join`, `channels:read`.
(`reactions:read` lets the app subscribe to `reaction_added` / `reaction_removed`.
`channels:read` lets `/dustystick joinall` enumerate public channels via
`conversations.list`, and `channels:join` lets the bot add itself via `conversations.join`
— both for the `joinall` backfill and the automatic join of newly created public channels.
`chat.getPermalink` — used to link the reacted-to message in the award's reason — needs
no extra scope beyond the bot being a member of the channel; if the bot isn't in the
channel the permalink lookup just fails and the reason falls back to a plain
`Reacted with :dusty_stick:`.)

> `should_escape: true` is the manifest equivalent of the Slack UI checkbox
> **"Escape channels, users, and links"** on the slash command. It is required so that
> mentioned users arrive as `<@U12345|username>` tokens the Worker can parse.

### 4. Set the Worker secrets

From your Slack app's settings pages:

- `SLACK_SIGNING_SECRET` — **Basic Information → App Credentials → Signing Secret**
- `SLACK_BOT_TOKEN` — **OAuth & Permissions → Bot User OAuth Token** (starts with `xoxb-`)

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints your Worker URL (e.g. `https://dusty-stick.<subdomain>.workers.dev`). Then:

1. Put that URL into the Slack app config — update the **slash command Request URL** and
   the **Event Subscriptions Request URL** (or edit the two URLs in the manifest and
   re-apply). Slack will verify the Events URL immediately via the `url_verification`
   handshake, which the Worker answers.
2. Confirm **"Escape channels, users, and links"** is enabled on the slash command
   (`should_escape: true`).
3. **Reinstall the app to the workspace** so the scopes/events take effect. A workspace
   **admin** performs the install. Adding the `reactions:read`, `channels:join`, and
   `channels:read` scopes and the `reaction_added` / `reaction_removed` /
   `channel_created` event subscriptions (as in the manifest above) requires this reinstall
   — without it the reaction feature and the auto-join won't fire.
4. Make sure the custom emoji **`:dusty_stick:`** exists in the workspace (Slack →
   emoji settings → add a custom emoji named `dusty_stick`). The reaction feature keys on
   that exact name, and the app's messages/leaderboard render it inline.
5. **Backfill channel membership:** run **`/dustystick joinall`** once. The bot enumerates
   all public channels and joins any it isn't already in, so it starts receiving
   `:dusty_stick:` reactions there (Slack only delivers reaction events for channels the
   bot is a member of). Joining a channel posts a one-time **"added to channel"** notice.
   New public channels are joined **automatically** from then on (the `channel_created`
   event). **Private** channels still require a manual **`/invite @Dusty Stick Awards`** —
   Slack does not allow bots to self-join private channels.

### 6. Test

- `/dustystick @someone crushed the deadline` → in-channel award announcement.
- `/dustystick leaderboard` → standings.
- `/dustystick recent` → recent awards.
- `/dustystick joinall` → bot joins all public channels (ephemeral "on it…" first, then a
  "Joined N public channels." follow-up). Run it once after installing.
- React with `:dusty_stick:` on someone else's message → award logged (the bot must be in
  the channel — run `joinall` or `/invite` it — so it can read the reaction and resolve the
  permalink). Remove the reaction → award revoked. Reacting on your own message does
  nothing.
- Open the app's **Home** tab → leaderboard + how-to.

---

## Local development

```bash
npm run dev     # wrangler dev
```

Note: signature verification and D1 still apply locally. Point a tunnel (e.g. Cloudflare
Tunnel) at the dev server and set the same secrets to exercise the full flow, or deploy
to a staging Worker.

## Files

```
slack-app/
├── README.md
├── package.json        # scripts: test, dev, deploy, db:init, db:migrate
├── wrangler.toml       # Worker config + D1 binding (DB)
├── schema.sql          # CREATE TABLE awards + indexes (fresh installs)
├── migrations/
│   └── 0001_add_reaction_support.sql  # ALTER TABLE for DBs created pre-reactions
├── test/
│   └── reactions.test.js               # functional test for reaction add/remove
└── src/
    ├── index.js        # entry point: routing, slash commands, events, reactions, App Home
    ├── verify.js       # Slack request signature verification (HMAC-SHA256)
    ├── db.js           # D1 queries (insert / delete reaction / leaderboard / recent)
    └── format.js       # escaping, relative time, Block Kit builders
```

## Notes / caveats

- For slash commands the invoking user is always the **giver**; the mentioned user is the
  **receiver**. For reactions the **reactor** is the giver and the **message author** is
  the receiver. Awards store a `source` of `command` or `reaction`.
- A `:dusty_stick:` reaction and its removal are matched by
  (`source`, `giver_id`, `receiver_id`, `channel_id`, `message_ts`). Slack permits only
  one reaction of a given emoji per user per message, so that tuple uniquely identifies
  the row to delete on `reaction_removed`.
- Responses stay well within Slack's 3-second window — D1 queries are simple and
  synchronous. Background work fired via `ctx.waitUntil` after Slack is ACKed: `views.publish`
  for the App Home, the `joinall` channel enumeration/join loop, and the `channel_created`
  auto-join.
- The bot's messages, leaderboard (the hall of shame), "recent" list, and App Home use the
  custom `:dusty_stick:` emoji shortcode. It's placed in `mrkdwn` section/context lines
  (where Slack renders custom emoji reliably) rather than in `header` blocks (plain_text,
  where a custom emoji can show as literal `:dusty_stick:` text). Headers stay plain text;
  the dubious-distinction rank badges (🚩/💀/🤡) live in the `mrkdwn` leaderboard lines.
- `joinall` is available to anyone (checking Slack admin status would need extra scopes),
  but it's safe: joins are idempotent, a `ratelimited` join is skipped without aborting the
  loop, and it only *adds* the bot to public channels.
- User-supplied text is escaped for Slack (`&`, `<`, `>`) and all SQL uses bound
  parameters, so input can't break formatting or the query.
