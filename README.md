# 🏆 Dusty Stick Awards

A tiny, self-contained tracker and leaderboard for Red Egg Marketing's most prestigious (and most inside) honor: the **Dusty Stick Award** 🌵🥢.

Log who gave a dusty stick to whom and why, then watch the leaderboard settle who truly reigns supreme.

## What it is

`index.html` is a single, fully self-contained web app — all HTML, CSS, and JavaScript inlined into one file. There is:

- **No build step**
- **No server**
- **No external dependencies, CDNs, or web fonts** (system font stack only, fully offline-capable)

Just open the file in a browser and go.

## How to use it

1. Open `index.html` in any modern web browser (double-click it, or drag it into a browser tab).
2. **Bestow a Dusty Stick** — fill in the *Giver*, *Receiver*, and *Reason*, then hit the button. All three fields are required. The timestamp is recorded automatically.
3. **Leaderboard** — receivers are ranked by how many dusty sticks they've received (most first). Ties share a rank.
4. **Recent Awards** — a newest-first feed of every award with a friendly relative timestamp (hover for the exact date/time).
5. **Delete** — click the ✕ on any award (with a confirm) to fix mistakes. The leaderboard recomputes instantly.

Names are tallied case-insensitively, so "Lucas" and "lucas" count as the same person. The most recently used spelling is shown as the canonical name.

## How data is stored

All data lives in your browser's **`localStorage`**, entirely **client-side** on the device/browser you're using. It survives page reloads and browser restarts, but:

- It is **not** shared between different browsers, devices, or people automatically.
- Clearing your browser data / site data will erase it.

Storage key: `dustyStickAwards.v1`.

## Backup & sharing (Export / Import)

Because the data is client-side only, **Export / Import JSON** is how you back it up or share it with a teammate.

- **Export JSON** downloads a `dusty-stick-awards-YYYY-MM-DD.json` file containing every award.
- **Import** accepts that JSON via **file upload** or by **pasting** it in. When you already have awards, importing lets you either **merge** (add the imported awards to what you have) or **replace** (swap in the imported data). Imported records are validated before anything is saved.

A typical sharing flow: one person exports the JSON, sends it (Slack, email, shared drive), and the other person imports it.

## Data model

Each award record is:

```json
{
  "id": "a_...",
  "giver": "Who gave the award",
  "receiver": "Who received it",
  "reason": "Why they earned it",
  "timestamp": "ISO 8601 date-time"
}
```

The exported file is simply an array of these objects.

---

Made with dust and questionable judgment. 🌵
