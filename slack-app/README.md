# Dusty Stick Awards — Slack App 🌵🏆

A Slack app for the Red Egg Marketing team to give and track **Dusty Stick Awards**.
It runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed by
[Cloudflare D1](https://developers.cloudflare.com/d1/) (serverless SQLite). No external
database server, no build step beyond Wrangler.

> Looking for the browser-only version? See `../index.html` in the repo root. This
> `slack-app/` directory is the standalone Slack + Cloudflare implementation.

## What it does

- **`/dustystick @person <reason>`** — award a dusty stick. Posts a playful in-channel
  announcement with giver, receiver, and reason.
- **`/dustystick leaderboard`** (also `board` / `top`) — standings by awards received.
- **`/dustystick recent`** — the last 10 awards.
- **`/dustystick help`** (or empty/unknown) — usage help.
- **App Home tab** — shows the leaderboard plus a short "how to use" section, refreshed
  each time someone opens the app's Home tab.

## Architecture at a glance

- One Worker URL handles everything. Slack sends:
  - **Slash commands** as `application/x-www-form-urlencoded` POSTs → dispatched when a
    `command` field is present.
  - **Events API** callbacks (`url_verification`, `app_home_opened`) as
    `application/json` POSTs → dispatched on the JSON `type` field.
  So both the **slash command Request URL** and the **Events Request URL** point at the
  *same* deployed Worker URL (the root `/`).
- **Signature verification** runs on every request: HMAC-SHA256 over
  `v0:{timestamp}:{raw_body}` using `SLACK_SIGNING_SECRET`, constant-time compared to
  `X-Slack-Signature`, rejecting timestamps older than 5 minutes (401 on failure).
- The App Home is published with `views.publish` using the bot token.

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
  description: Give and track Dusty Stick Awards 🌵🏆
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
      description: Give or track Dusty Stick Awards
      usage_hint: "@person <reason>  |  leaderboard  |  recent  |  help"
      # IMPORTANT: this must be true so Slack sends <@U123|name> mention tokens.
      should_escape: true
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - users:read
settings:
  event_subscriptions:
    request_url: https://YOUR-WORKER-URL.workers.dev/
    bot_events:
      - app_home_opened
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

**Request URLs:** both the slash command `url` and the Events `request_url` point to the
Worker's root URL. The Worker distinguishes them by content-type / payload shape.

**Required bot scopes:** `commands`, `chat:write`, `users:read`.

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
   **admin** performs the install.

### 6. Test

- `/dustystick @someone crushed the deadline` → in-channel award announcement.
- `/dustystick leaderboard` → standings.
- `/dustystick recent` → recent awards.
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
├── package.json        # scripts: dev, deploy, db:init
├── wrangler.toml       # Worker config + D1 binding (DB)
├── schema.sql          # CREATE TABLE awards + indexes
└── src/
    ├── index.js        # entry point: routing, slash commands, events, App Home
    ├── verify.js       # Slack request signature verification (HMAC-SHA256)
    ├── db.js           # D1 queries (insert / leaderboard / recent)
    └── format.js       # escaping, relative time, Block Kit builders
```

## Notes / caveats

- The invoking user is always the **giver**; the mentioned user is the **receiver**.
- Responses stay well within Slack's 3-second window — D1 queries are simple and
  synchronous. The only background work is `views.publish` for the App Home, which is
  fired via `ctx.waitUntil` after Slack is ACKed.
- User-supplied text is escaped for Slack (`&`, `<`, `>`) and all SQL uses bound
  parameters, so input can't break formatting or the query.
