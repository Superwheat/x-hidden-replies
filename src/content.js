/*
 * X Hidden Replies Revealer - content script (ISOLATED world)
 * ----------------------------------------------------------
 * The page-context script embeds hidden replies into TweetDetail as real X
 * timeline entries. This script only marks the real reply cells X renders.
 */
(() => {
  'use strict';

  const TAG = '[HiddenReplies]';
  const TOOLTIP = 'This reply has been marked as hidden by the creator';

  const hiddenByTweet = new Map(); // root tweet id -> Set(hidden reply ids)
  const renderWarnTimers = new Map();
  let lastTweetId = null;
  let debounceTimer = null;
  let markLoggedFor = null;

  function currentTweetId() {
    const p = location.pathname;
    const m =
      p.match(/^\/[^/]+\/status\/(\d+)/) ||
      p.match(/^\/i\/web\/status\/(\d+)/) ||
      p.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function isHiddenRepliesPage() {
    return /\/status\/\d+\/hidden(?:[/?#]|$)/.test(location.pathname);
  }

  function statusIdOf(article) {
    const timeLink = article.querySelector('a[href*="/status/"] time');
    const a = (timeLink && timeLink.closest('a')) || article.querySelector('a[href*="/status/"]');
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function replyCells() {
    return document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="cellInnerDiv"]');
  }

  function setHiddenMarker(cell, id) {
    cell.setAttribute('data-hrx-hidden-reply', 'true');
    cell.setAttribute('data-hrx-hidden-reply-id', id);
    cell.setAttribute('title', TOOLTIP);
  }

  function clearHiddenMarker(cell) {
    cell.removeAttribute('data-hrx-hidden-reply');
    cell.removeAttribute('data-hrx-hidden-reply-id');
    cell.removeAttribute('title');
  }

  function markHiddenReplies(tweetId) {
    const ids = hiddenByTweet.get(String(tweetId));
    let marked = 0;

    replyCells().forEach((cell) => {
      const article = cell.querySelector('article');
      if (!article) {
        clearHiddenMarker(cell);
        return;
      }

      const id = statusIdOf(article);
      if (id && ids && ids.has(id) && id !== String(tweetId)) {
        setHiddenMarker(cell, id);
        marked++;
      } else if (cell.hasAttribute('data-hrx-hidden-reply')) {
        clearHiddenMarker(cell);
      }
    });

    if (marked && markLoggedFor !== tweetId) {
      markLoggedFor = tweetId;
      console.log(TAG, 'marked ' + marked + ' X-rendered hidden repl' + (marked === 1 ? 'y' : 'ies'));
    }
    window.postMessage({
      source: 'HRX_CS',
      type: 'MARK_STATUS',
      tweetId: String(tweetId),
      hiddenIds: ids ? ids.size : 0,
      marked: marked
    }, location.origin);
    return marked;
  }

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const id = currentTweetId();
      if (isHiddenRepliesPage()) {
        lastTweetId = null;
        markLoggedFor = null;
        replyCells().forEach(clearHiddenMarker);
        return;
      }
      if (id !== lastTweetId) {
        lastTweetId = id;
        markLoggedFor = null;
        replyCells().forEach(clearHiddenMarker);
        window.postMessage({ source: 'HRX_CS', type: 'HRX_READY', tweetId: id }, location.origin);
      }
      if (id) markHiddenReplies(id);
    }, 250);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'HRX_PAGE' || d.type !== 'HIDDEN_IDS' || !d.tweetId) return;

    const ids = Array.isArray(d.ids) ? d.ids.map(String).filter(Boolean) : [];
    hiddenByTweet.set(String(d.tweetId), new Set(ids));
    console.log(TAG, 'page hook reported ' + ids.length + ' embedded hidden repl' + (ids.length === 1 ? 'y' : 'ies'));
    clearTimeout(renderWarnTimers.get(String(d.tweetId)));
    if (ids.length) {
      renderWarnTimers.set(String(d.tweetId), setTimeout(() => {
        if (currentTweetId() === String(d.tweetId) && markHiddenReplies(d.tweetId) === 0) {
          console.warn(TAG, 'hidden replies were fetched, but X has not rendered matching native reply cells yet; refresh the tweet page after reloading the extension');
        }
      }, 4000));
    }
    schedule();
  });

  console.log('%c[HiddenReplies]', 'color:#f59e0b;font-weight:bold', 'content script loaded - marking X-rendered hidden replies');

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);

  schedule();
})();
