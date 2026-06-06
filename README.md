# X Hidden Replies Revealer

A browser extension (Chrome / Edge / Brave, Manifest V3) that automatically pulls
the replies an author has **hidden** on a tweet and embeds them into the normal
conversation as real X-rendered replies, visually marked with a subtle amber tint.

## How it works

Author-hidden replies live at the `/<user>/status/<id>/hidden` route, which X
renders via a separate internal GraphQL operation called `ModeratedTimeline`.
That route sends `X-Frame-Options: DENY`, so it can't be loaded in a hidden
iframe, and fetching the URL just returns the app shell with no data — so the
extension calls the same `ModeratedTimeline` GraphQL endpoint the page uses
internally, automatically, for every tweet you open:

1. **`src/inject.js`** runs in the **page's own JS context** (`world: "MAIN"`) at
   `document_start`. It hooks `fetch`/`XMLHttpRequest` to passively capture the
   things X needs for an authenticated GraphQL call — the bearer token, client
   language, live feature flags, and per-operation query IDs — from traffic the
   page already makes. It then **replays the `ModeratedTimeline` query itself**
   using your existing logged-in session. The query ID and the exact feature/
   field-toggle key set are baked in (extracted from X's `main.js`) so it works
   immediately; captured live values are merged over them, and if the baked-in
   query ID ever 404s it rescans the loaded bundles and retries once.
2. **`src/content.js`** runs in the isolated content-script world. It does not
   render hidden replies itself. It only receives the ids the page hook embedded
   and marks those already-rendered X reply cells.
3. **`src/styles.css`** gives the real X reply cells a subtle amber tint.

Everything happens locally in your browser. No data is sent anywhere except to
`x.com` itself — the same requests the site already makes.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select the `x-hidden-replies` folder.
4. Open any tweet that has hidden replies, e.g.
   `https://x.com/<user>/status/<id>`. Hidden replies appear as native X reply
   cells with a subtle tint.

> Firefox: works the same, but MAIN-world content scripts need Firefox 128+.
> Older Firefox would need the script injected via a `<script>` tag instead.

## Notes & limitations

- You must be **logged in** to X — hidden replies require an authenticated
  session.
- X's internal API changes over time. The query ID and feature flags are handled
  with layered fallbacks in `src/inject.js`:
  - Query ID: baked-in `FALLBACK_QUERY_ID` (currently `u74Eui5NKTnQmkd6RrLfuA`)
    → overridden by a live-captured ID if X calls the op → self-heals via a
    bundle rescan + retry if the baked-in ID 404s.
  - Feature flags: the full canonical key set (`MODERATED_FEATURES`) is always
    sent so no required key is ever missing; live-captured values are merged in
    for accuracy.
- If hidden replies stop appearing after an X update, open DevTools → Console and
  look for `[HiddenReplies]` warnings. `HTTP_4xx` / `GRAPHQL_ERROR` usually names
  the problem — e.g. a new required feature flag to add to `MODERATED_FEATURES`.
- It only reads the first page (up to ~40) of hidden replies per tweet.

## Files

| File              | Role                                                    |
| ----------------- | ------------------------------------------------------- |
| `manifest.json`   | MV3 manifest, registers the two content scripts         |
| `src/inject.js`   | Page-context interceptor + `ModeratedTimeline` fetcher  |
| `src/content.js`  | Marks embedded native reply cells, handles SPA nav      |
| `src/styles.css`  | Amber native-cell styling                               |
