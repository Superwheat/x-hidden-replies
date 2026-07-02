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
  const SETTINGS_KEY = 'hrxSettings';
  const DEFAULT_SETTINGS = { disabledAccounts: [], disableOwnAccount: false, ownAccount: '' };

  const hiddenByTweet = new Map(); // root tweet id -> Set(hidden reply ids)
  const knownHiddenReplyIds = new Set();
  let settings = DEFAULT_SETTINGS;
  let lastViewerAccount = null;
  let lastTweetId = null;
  let scheduledFrame = null;
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

  function normalizeScreenName(value) {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function normalizeSettings(input) {
    const value = input && typeof input === 'object' ? input : {};
    const seen = new Set();
    const disabledAccounts = [];
    const rawAccounts = Array.isArray(value.disabledAccounts) ? value.disabledAccounts : [];
    for (const account of rawAccounts) {
      const key = normalizeScreenName(account);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      disabledAccounts.push(key);
    }
    return {
      disabledAccounts: disabledAccounts,
      disableOwnAccount: value.disableOwnAccount === true,
      ownAccount: normalizeScreenName(value.ownAccount)
    };
  }

  function routeScreenName() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;

    const key = normalizeScreenName(parts[0]);
    if (!key || isReservedPath(key)) return null;

    const section = String(parts[1] || '').toLowerCase();
    if (section === 'status' && /^\d+$/.test(String(parts[2] || ''))) return key;
    if (parts.length === 1) return key;
    if (/^(with_replies|media|likes|highlights|articles|followers|following|verified_followers)$/.test(section)) return key;
    return null;
  }

  function isReservedPath(name) {
    return /^(home|explore|notifications|messages|i|settings|compose|search|jobs|login|logout|signup|tos|privacy)$/i.test(String(name || ''));
  }

  function screenNameFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(u.hostname)) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const key = normalizeScreenName(parts[0]);
      return key && !isReservedPath(key) ? key : null;
    } catch (_) {
      return null;
    }
  }

  function viewerScreenName() {
    const selectors = [
      'a[data-testid="AppTabBar_Profile_Link"]',
      'a[aria-label="Profile"]',
      'nav a[href^="/"]'
    ];
    for (const selector of selectors) {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const key = screenNameFromHref(link.getAttribute('href') || link.href);
        if (key) return key;
      }
    }
    return settings.ownAccount || '';
  }

  function effectiveSettings() {
    const ownAccount = viewerScreenName() || settings.ownAccount;
    return Object.assign({}, settings, { ownAccount: ownAccount || '' });
  }

  function pageContext() {
    const ownAccount = viewerScreenName() || settings.ownAccount || '';
    const screenName = routeScreenName();
    return {
      tweetId: currentTweetId(),
      screenName: screenName && screenName !== ownAccount ? screenName : null,
      ownAccount: ownAccount
    };
  }

  function postSettings() {
    const nextSettings = effectiveSettings();
    window.postMessage({
      source: 'HRX_CS',
      type: 'SETTINGS_UPDATE',
      settings: nextSettings,
      context: pageContext()
    }, location.origin);
  }

  function persistDetectedOwnAccount(account) {
    const key = normalizeScreenName(account);
    if (!key || key === settings.ownAccount) return;
    settings = Object.assign({}, settings, { ownAccount: key });
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }
  }

  function loadSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      settings = DEFAULT_SETTINGS;
      postSettings();
      return;
    }
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (items) => {
      settings = normalizeSettings(items && items[SETTINGS_KEY]);
      persistDetectedOwnAccount(viewerScreenName());
      postSettings();
    });
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
    removeFocusedHiddenLabel(cell);
    cell.removeAttribute('data-hrx-focused-hidden-reply');
    cell.setAttribute('data-hrx-hidden-reply', 'true');
    cell.setAttribute('data-hrx-hidden-reply-id', id);
    cell.setAttribute('title', TOOLTIP);
  }

  function setFocusedHiddenMarker(cell, id) {
    cell.removeAttribute('data-hrx-hidden-reply');
    cell.setAttribute('data-hrx-focused-hidden-reply', 'true');
    cell.setAttribute('data-hrx-hidden-reply-id', id);
    cell.setAttribute('title', TOOLTIP);
    syncFocusedHiddenLabel(cell);
  }

  function clearHiddenMarker(cell) {
    removeFocusedHiddenLabel(cell);
    cell.removeAttribute('data-hrx-hidden-reply');
    cell.removeAttribute('data-hrx-focused-hidden-reply');
    cell.removeAttribute('data-hrx-hidden-reply-id');
    cell.removeAttribute('title');
  }

  function removeFocusedHiddenLabel(root) {
    root.querySelectorAll('[data-hrx-focused-hidden-label="true"]').forEach((el) => el.remove());
  }

  function directChildContaining(parent, node) {
    let child = node;
    while (child && child.parentElement !== parent) child = child.parentElement;
    return child && child.parentElement === parent ? child : null;
  }

  function focusedHiddenLabelSlot(article) {
    const userName = article && article.querySelector('[data-testid="User-Name"]');
    if (!userName) return null;

    const action = article.querySelector('[data-testid="caret"], button[aria-label="More"], div[aria-label="More"][role="button"]');
    if (action && !userName.contains(action)) {
      let row = userName.parentElement;
      while (row && row !== article) {
        const userNameChild = directChildContaining(row, userName);
        const actionChild = directChildContaining(row, action);
        if (userNameChild && actionChild && userNameChild !== actionChild) {
          return { host: row, before: actionChild, placement: 'header' };
        }
        row = row.parentElement;
      }
    }

    const time = userName.querySelector('time');
    if (time) {
      const timeLink = time.closest('a');
      const host = timeLink && timeLink.parentElement;
      if (host && userName.contains(host)) return { host: host, before: null, placement: 'metadata' };
    }

    const textRows = userName.querySelectorAll('div[dir="ltr"]');
    return { host: textRows.length ? textRows[textRows.length - 1] : userName, before: null, placement: 'metadata' };
  }

  function syncFocusedHiddenLabel(cell) {
    const article = cell.querySelector('article');
    const slot = focusedHiddenLabelSlot(article);
    if (!slot || !slot.host) return;

    removeFocusedHiddenLabel(cell);

    const label = document.createElement('span');
    label.setAttribute('data-hrx-focused-hidden-label', 'true');
    label.setAttribute('data-hrx-focused-hidden-label-placement', slot.placement);
    label.setAttribute('aria-label', 'Hidden reply');
    label.textContent = 'Hidden';
    slot.host.insertBefore(label, slot.before);
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
      if (id && id === String(tweetId) && knownHiddenReplyIds.has(id)) {
        setFocusedHiddenMarker(cell, id);
      } else if (id && ids && ids.has(id) && id !== String(tweetId)) {
        setHiddenMarker(cell, id);
        marked++;
      } else if (cell.hasAttribute('data-hrx-hidden-reply') || cell.hasAttribute('data-hrx-focused-hidden-reply')) {
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

  // Coalesce mutation bursts to one run per frame instead of debouncing: a
  // resetting timer keeps getting pushed back while X re-renders the timeline
  // (e.g. navigating back to a tweet), which delays the highlight.
  function schedule() {
    if (scheduledFrame !== null) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = null;
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
        postSettings();
        window.postMessage({ source: 'HRX_CS', type: 'HRX_READY', tweetId: id }, location.origin);
      }
      const viewer = viewerScreenName();
      if (viewer !== lastViewerAccount) {
        lastViewerAccount = viewer;
        persistDetectedOwnAccount(viewer);
        postSettings();
      }
      if (id) markHiddenReplies(id);
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'HRX_PAGE' || d.type !== 'HIDDEN_IDS' || !d.tweetId) return;

    const ids = Array.isArray(d.ids) ? d.ids.map(String).filter(Boolean) : [];
    ids.forEach((id) => knownHiddenReplyIds.add(id));
    hiddenByTweet.set(String(d.tweetId), new Set(ids));
    console.log(TAG, 'page hook reported ' + ids.length + ' embedded hidden repl' + (ids.length === 1 ? 'y' : 'ies'));
    schedule();
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      postSettings();
      schedule();
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.source !== 'HRX_POPUP') return false;
      if (message.type === 'GET_CONTEXT') {
        persistDetectedOwnAccount(viewerScreenName());
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: true, context: pageContext(), settings: effectiveSettings() });
        }
        return false;
      }
      if (message.type !== 'SETTINGS_CHANGED') return false;
      loadSettings();
      if (typeof sendResponse === 'function') sendResponse({ ok: true });
      return false;
    });
  }

  console.log('%c[HiddenReplies]', 'color:#f59e0b;font-weight:bold', 'content script loaded - marking X-rendered hidden replies');

  const mo = new MutationObserver(schedule);
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });
      schedule();
    }, { once: true });
  }
  window.addEventListener('popstate', schedule);

  loadSettings();
  schedule();
})();
