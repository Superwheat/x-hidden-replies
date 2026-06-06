# X Hidden Replies Revealer

A small browser extension that shows replies hidden by the author on X/Twitter.

Hidden replies are inserted back into the conversation as native X reply cells, not custom cards. Marked hidden replies get a subtle amber tint and the normal browser tooltip.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, Edge, or Brave.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `x-hidden-replies` folder.

## Use

Open any X/Twitter post that has hidden replies:

```text
https://x.com/<user>/status/<post-id>
```

Hidden replies should appear in the normal reply thread. If you click into a hidden reply, replies inside that hidden thread should also appear normally.

## Notes

- You must be logged in to X/Twitter.
- The extension only talks to `x.com`/`twitter.com`.
- Hidden replies are rendered by X itself, then lightly marked by the extension.
- X changes its internal API often, so reload the extension after updating.

## Troubleshooting

If replies do not appear:

1. Reload the extension from `chrome://extensions`.
2. Hard-refresh the X/Twitter tab.
3. Open DevTools and check the Console for `[HiddenReplies]` messages.

The debug object is available at:

```js
window.__HRX_DEBUG__
```

## Files

```text
manifest.json      Extension manifest
src/inject.js      X/Twitter request hook and native reply merge
src/content.js     Marks rendered hidden reply cells
src/styles.css     Subtle hidden-reply tint
```
