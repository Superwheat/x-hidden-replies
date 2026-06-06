/*
 * X Hidden Replies Revealer — page-context script (MAIN world)
 * ------------------------------------------------------------
 * Author-hidden replies are served by the internal "ModeratedTimeline" GraphQL
 * query (the data behind /<user>/status/<id>/hidden, which can't be iframed —
 * X-Frame-Options: DENY). Rather than render our own cards (which fight X's
 * virtualized list), we intercept the conversation's "TweetDetail" response and
 * splice the hidden replies into it as real timeline entries. X then renders
 * them as genuine reply cells, and the content script tints them by id.
 */
(() => {
  'use strict';

  const TAG = '[HiddenReplies/page]';

  const FALLBACK_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const FALLBACK_QUERY_ID = 'u74Eui5NKTnQmkd6RrLfuA';
  const FALLBACK_TWEET_DETAIL_QUERY_ID = 'RguQ9yvaXf-EETmDagsLzg';

  const MODERATED_FEATURES = [
    'rweb_video_screen_enabled', 'rweb_cashtags_enabled',
    'profile_label_improvements_pcf_label_in_post_enabled',
    'responsive_web_profile_redirect_enabled', 'rweb_tipjar_consumption_enabled',
    'verified_phone_label_enabled', 'creator_subscriptions_tweet_preview_api_enabled',
    'responsive_web_graphql_timeline_navigation_enabled',
    'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
    'premium_content_api_read_enabled', 'communities_web_enable_tweet_community_results_fetch',
    'c9s_tweet_anatomy_moderator_badge_enabled',
    'responsive_web_grok_analyze_button_fetch_trends_enabled',
    'responsive_web_grok_analyze_post_followups_enabled',
    'rweb_cashtags_composer_attachment_enabled', 'responsive_web_jetfuel_frame',
    'responsive_web_grok_share_attachment_enabled', 'responsive_web_grok_annotations_enabled',
    'articles_preview_enabled', 'responsive_web_edit_tweet_api_enabled',
    'rweb_conversational_replies_downvote_enabled',
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
    'view_counts_everywhere_api_enabled', 'longform_notetweets_consumption_enabled',
    'responsive_web_twitter_article_tweet_consumption_enabled',
    'content_disclosure_indicator_enabled', 'content_disclosure_ai_generated_indicator_enabled',
    'responsive_web_grok_show_grok_translated_post', 'responsive_web_grok_analysis_button_from_backend',
    'post_ctas_fetch_enabled', 'freedom_of_speech_not_reach_fetch_enabled',
    'standardized_nudges_misinfo',
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
    'longform_notetweets_rich_text_read_enabled', 'longform_notetweets_inline_media_enabled',
    'responsive_web_grok_image_annotation_enabled', 'responsive_web_grok_imagine_annotation_enabled',
    'responsive_web_grok_community_note_auto_translation_is_enabled',
    'responsive_web_enhance_cards_enabled'
  ];
  const FEATURE_DEFAULT_FALSE = new Set([
    'rweb_video_screen_enabled', 'verified_phone_label_enabled', 'premium_content_api_read_enabled',
    'responsive_web_grok_analyze_button_fetch_trends_enabled', 'responsive_web_jetfuel_frame',
    'responsive_web_grok_show_grok_translated_post', 'responsive_web_enhance_cards_enabled'
  ]);
  const MODERATED_FIELD_TOGGLES = [
    'withPayments', 'withAuxiliaryUserLabels', 'withArticleRichContentState',
    'withArticlePlainText', 'withArticleSummaryText', 'withArticleVoiceOver',
    'withGrokAnalyze', 'withDisallowedReplyControls'
  ];

  const origFetch = window.fetch;
  const XHRopen = XMLHttpRequest.prototype.open;
  const XHRsetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const XHRsend = XMLHttpRequest.prototype.send;
  const XHRresponseText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
  const XHRresponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');

  const state = {
    bearer: null,
    lang: null,
    ops: Object.assign(Object.create(null), {
      ModeratedTimeline: FALLBACK_QUERY_ID,
      TweetDetail: FALLBACK_TWEET_DETAIL_QUERY_ID
    }),
    featuresObj: null,
    fieldTogglesObj: null,
    graphqlOrigin: null,
    graphqlPrefix: '/graphql'
  };
  const moderatedPromises = new Map(); // rootId -> Promise<{ok,results,ids}>
  const moderatedResults = new Map();  // rootId -> resolved {ok,results,ids}
  const hiddenThreadRepliesByParent = new Map(); // hidden reply id -> reply children captured from a hidden thread
  const hiddenIdsByRoot = new Map();   // rootId -> hidden reply ids embedded into TweetDetail
  const debugState = window.__HRX_DEBUG__ = window.__HRX_DEBUG__ || { tweets: Object.create(null), graphqlSeen: [], fetchSeen: [], xhrSeen: [] };

  function debugTweet(rootId, patch) {
    if (!rootId) return;
    const id = String(rootId);
    debugState.tweets[id] = Object.assign(debugState.tweets[id] || {}, patch);
    debugState.lastTweetId = id;
  }

  function debugGraphql(info, operationName) {
    if (!info) return;
    if (!Array.isArray(debugState.graphqlSeen)) debugState.graphqlSeen = [];
    debugState.graphqlSeen.push({
      operationName: operationName || info.operationName || null,
      queryId: info.queryId || null,
      path: info.url && info.url.pathname,
      at: Date.now()
    });
    if (debugState.graphqlSeen.length > 30) debugState.graphqlSeen.shift();
  }

  function pushDebugList(name, item, max) {
    if (!Array.isArray(debugState[name])) debugState[name] = [];
    debugState[name].push(Object.assign({ at: Date.now() }, item));
    while (debugState[name].length > (max || 30)) debugState[name].shift();
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function rememberFromUrl(rawUrl) {
    try {
      if (!mightBeGraphqlUrl(rawUrl)) return;
      const u = new URL(rawUrl, location.origin);
      const m = u.pathname.match(/(?:^|\/)(?:i\/api\/)?graphql\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (!m) return;
      const opName = m[2] ? decodeURIComponent(m[2]) : null;
      if (opName) state.ops[opName] = m[1];
      state.graphqlOrigin = u.origin;
      state.graphqlPrefix = u.pathname.indexOf('/i/api/graphql/') === 0 ? '/i/api/graphql' : '/graphql';
      if (opName === 'TweetDetail' || !state.featuresObj) {
        const f = u.searchParams.get('features');
        if (f) try { state.featuresObj = JSON.parse(f); } catch (_) { /* ignore */ }
      }
      if (opName === 'TweetDetail' || !state.fieldTogglesObj) {
        const ft = u.searchParams.get('fieldToggles');
        if (ft) try { state.fieldTogglesObj = JSON.parse(ft); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
  }

  function mightBeGraphqlUrl(rawUrl) {
    return /(?:^|\/)(?:i\/api\/)?graphql(?:\/|$|\?)/i.test(String(rawUrl || ''));
  }

  function graphqlInfo(rawUrl) {
    try {
      if (!mightBeGraphqlUrl(rawUrl)) return null;
      const u = new URL(rawUrl, location.origin);
      const m = u.pathname.match(/(?:^|\/)(?:i\/api\/)?graphql\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (!m) return null;
      return { url: u, queryId: m[1], operationName: m[2] ? decodeURIComponent(m[2]) : null };
    } catch (_) {
      return null;
    }
  }

  function operationNameFor(info, bodyVars) {
    if (!info) return null;
    if (info.operationName) return info.operationName;
    if (info.queryId === state.ops.TweetDetail || info.queryId === FALLBACK_TWEET_DETAIL_QUERY_ID) return 'TweetDetail';
    if (info.queryId === state.ops.ModeratedTimeline || info.queryId === FALLBACK_QUERY_ID) return 'ModeratedTimeline';
    if (bodyVars && bodyVars.focalTweetId) return 'TweetDetail';
    if (bodyVars && bodyVars.rootTweetId) return 'ModeratedTimeline';
    return null;
  }

  function rememberHeaders(headers) {
    try {
      if (!headers) return;
      const read = (k) => {
        if (typeof headers.get === 'function') return headers.get(k);
        if (Array.isArray(headers)) { const e = headers.find((p) => String(p[0]).toLowerCase() === k); return e ? e[1] : null; }
        const kk = Object.keys(headers).find((x) => x.toLowerCase() === k); return kk ? headers[kk] : null;
      };
      const auth = read('authorization'); if (auth) state.bearer = auth;
      const lang = read('x-twitter-client-language'); if (lang) state.lang = lang;
    } catch (_) { /* ignore */ }
  }

  function varsFromUrl(url) {
    try { const u = new URL(url, location.origin); const v = u.searchParams.get('variables'); return v ? JSON.parse(v) : null; }
    catch (_) { return null; }
  }

  function varsFromTextBody(text) {
    if (!text || typeof text !== 'string') return null;
    try {
      const json = JSON.parse(text);
      if (json && json.variables) return typeof json.variables === 'string' ? JSON.parse(json.variables) : json.variables;
    } catch (_) { /* ignore */ }
    try {
      const params = new URLSearchParams(text);
      const vars = params.get('variables');
      return vars ? JSON.parse(vars) : null;
    } catch (_) { /* ignore */ }
    return null;
  }

  function varsFromBody(body) {
    if (!body) return null;
    if (typeof body === 'string') return varsFromTextBody(body);
    if (body instanceof URLSearchParams) return varsFromTextBody(body.toString());
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text().then(varsFromTextBody).catch(() => null);
    if (body instanceof ArrayBuffer) {
      try { return varsFromTextBody(new TextDecoder().decode(body)); } catch (_) { return null; }
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const vars = body.get('variables');
      if (typeof vars === 'string') return varsFromTextBody('variables=' + encodeURIComponent(vars));
    }
    return null;
  }

  async function tdVars(input, init, url, requestClone) {
    const fromUrl = varsFromUrl(url);
    if (fromUrl) return fromUrl;
    const fromInitBody = await varsFromBody(init && init.body);
    if (fromInitBody) return fromInitBody;
    if (requestClone && requestClone.method && requestClone.method.toUpperCase() !== 'GET') {
      try { return varsFromTextBody(await requestClone.text()); }
      catch (_) { /* ignore */ }
    }
    return null;
  }

  function installXhrResponseOverride(xhr) {
    if (xhr.__hrxResponseOverrideInstalled) return;
    xhr.__hrxResponseOverrideInstalled = true;
    try {
      if (XHRresponseText && XHRresponseText.get) {
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get: function () {
            if (this.__hrxResponseText != null) return this.__hrxResponseText;
            return XHRresponseText.get.call(this);
          }
        });
      }
      if (XHRresponse && XHRresponse.get) {
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () {
            if (this.__hrxResponseText != null && (!this.responseType || this.responseType === 'text')) return this.__hrxResponseText;
            if (this.__hrxResponseJson != null && this.responseType === 'json') return this.__hrxResponseJson;
            return XHRresponse.get.call(this);
          }
        });
      }
    } catch (e) {
      try { console.warn(TAG, 'could not install XHR response override:', (e && e.message) || e); } catch (_) { /* ignore */ }
    }
  }

  function applyHiddenToTweetDetailJson(json, rootId, mod) {
    if (!mod || !mod.ok) {
      debugTweet(rootId, { mergeSkipped: (mod && mod.error) || 'NO_RESULT' });
      if (mod && mod.error !== 'NO_QUERY_ID') console.warn(TAG, 'hidden fetch failed:', mod && mod.error, (mod && mod.status) || '');
      return false;
    }
    if (!mod.results.length) {
      debugTweet(rootId, { mergeSkipped: 'NO_HIDDEN_RESULTS' });
      return false;
    }
    const merged = mergeHidden(json, mod.results, rootId, { allowFocalFallback: !!mod.threadReplyCount });
    if (merged !== true) {
      if (merged !== 'WAITING_FOR_REPLY_TEMPLATE') {
        debugTweet(rootId, { mergeSkipped: 'UNEXPECTED_TWEETDETAIL_SHAPE' });
        console.warn(TAG, 'could not splice into TweetDetail (unexpected shape)');
      }
      return false;
    }
    const hiddenCount = Array.isArray(mod.ids) ? mod.ids.length : 0;
    const threadReplyCount = mod.threadReplyCount || 0;
    rememberHiddenIds(rootId, mod.ids);
    debugTweet(rootId, { responseRewritten: true, embeddedHiddenReplies: hiddenCount, embeddedThreadReplies: threadReplyCount });
    console.log('%c[HiddenReplies]', 'color:#f59e0b;font-weight:bold', 'embedded ' + hiddenCount + ' hidden repl' + (hiddenCount === 1 ? 'y' : 'ies') + (threadReplyCount ? ' and ' + threadReplyCount + ' hidden-thread repl' + (threadReplyCount === 1 ? 'y' : 'ies') : '') + ' into the conversation');
    return true;
  }

  function setupXhrTweetDetailMerge(xhr, rawUrl, vars) {
    if (!vars || !vars.focalTweetId || xhr.__hrxTweetDetailMergeInstalled) return;
    xhr.__hrxTweetDetailMergeInstalled = true;
    const rootId = String(vars.focalTweetId);
    debugTweet(rootId, { tweetDetailIntercepted: true, tweetDetailTransport: 'xhr', tweetDetailCursor: !!vars.cursor, tweetDetailUrl: rawUrl, tweetDetailVarsSource: varsFromUrl(rawUrl) ? 'url' : 'body', interceptedAt: Date.now() });
    getModerated(rootId);
    installXhrResponseOverride(xhr);

    const rewrite = function () {
      if (xhr.readyState !== 4 || xhr.__hrxResponseText != null) return;
      const mod = modWithCachedThreadReplies(rootId, moderatedResults.get(rootId));
      if (!mod) {
        debugTweet(rootId, { xhrRewriteSkipped: 'MODERATED_NOT_READY' });
        return;
      }
      try {
        const text = XHRresponseText && XHRresponseText.get ? XHRresponseText.get.call(xhr) : xhr.responseText;
        if (!text) return;
        const json = JSON.parse(text);
        if (!applyHiddenToTweetDetailJson(json, rootId, mod)) return;
        xhr.__hrxResponseJson = json;
        xhr.__hrxResponseText = JSON.stringify(json);
        debugTweet(rootId, { xhrResponseRewritten: true });
      } catch (e) {
        debugTweet(rootId, { xhrRewriteError: String((e && e.message) || e) });
      }
    };

    try {
      xhr.addEventListener('readystatechange', rewrite, true);
      xhr.addEventListener('load', rewrite, true);
    } catch (_) { /* ignore */ }
  }

  // --- intercept GraphQL: passive capture + TweetDetail response merge --------
  window.fetch = function (input, init) {
    let url;
    try { url = (typeof input === 'string' || input instanceof URL) ? String(input) : (input && input.url); } catch (_) { /* ignore */ }
    let requestClone = null;
    try { if (typeof Request !== 'undefined' && input instanceof Request) requestClone = input.clone(); } catch (_) { /* ignore */ }
    const gql = url ? graphqlInfo(url) : null;
    if (url && mightBeGraphqlUrl(url)) {
      pushDebugList('fetchSeen', { url: String(url).slice(0, 300), matchedGraphql: !!gql }, 50);
    }
    if (gql) {
      rememberFromUrl(url);
      rememberHeaders((init && init.headers) || (input && input.headers));
    }
    const p = origFetch.apply(this, arguments);
    if (!gql) return p;

    return Promise.resolve(tdVars(input, init, url, requestClone)).then((vars) => {
      const operationName = operationNameFor(gql, vars);
      debugGraphql(gql, operationName);
      if (operationName !== 'TweetDetail') return p;
      if (!vars || !vars.focalTweetId) return p;
      const rootId = String(vars.focalTweetId);
      debugTweet(rootId, { tweetDetailIntercepted: true, tweetDetailCursor: !!vars.cursor, tweetDetailUrl: url, tweetDetailVarsSource: varsFromUrl(url) ? 'url' : 'body', interceptedAt: Date.now() });
      getModerated(rootId); // kick off the hidden-replies fetch in parallel
      return p.then((res) => mergeIntoTweetDetail(res, rootId)).catch(() => p);
    }).catch(() => p);
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hrxUrl = url;
    this.__hrxMethod = method;
    let setupVars = null;
    let setupRawUrl = null;
    try {
      const rawUrl = String(url || '');
      const gql = graphqlInfo(rawUrl);
      const vars = varsFromUrl(rawUrl);
      if (mightBeGraphqlUrl(rawUrl)) {
        pushDebugList('xhrSeen', { phase: 'open', method: String(method || 'GET'), url: rawUrl.slice(0, 300), matchedGraphql: !!gql }, 50);
      }
      if (operationNameFor(gql, vars) === 'TweetDetail') {
        setupRawUrl = rawUrl;
        setupVars = vars;
      }
    } catch (_) { /* ignore */ }
    if (url && graphqlInfo(String(url))) rememberFromUrl(String(url));
    const ret = XHRopen.apply(this, arguments);
    if (setupVars) setupXhrTweetDetailMerge(this, setupRawUrl, setupVars);
    return ret;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__hrxUrl && graphqlInfo(String(this.__hrxUrl))) {
        const kl = String(k).toLowerCase();
        if (kl === 'authorization') state.bearer = v;
        else if (kl === 'x-twitter-client-language') state.lang = v;
      }
    } catch (_) { /* ignore */ }
    return XHRsetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const rawUrl = String(this.__hrxUrl || '');
      const gql = rawUrl ? graphqlInfo(rawUrl) : null;
      if (mightBeGraphqlUrl(rawUrl)) {
        Promise.resolve(varsFromBody(body)).then((vars) => {
          vars = varsFromUrl(rawUrl) || vars;
          const operationName = operationNameFor(gql, vars);
          pushDebugList('xhrSeen', {
            phase: 'send',
            method: String(this.__hrxMethod || 'GET'),
            url: rawUrl.slice(0, 300),
            matchedGraphql: !!gql,
            operationName: operationName || null,
            hasFocalTweetId: !!(vars && vars.focalTweetId),
            hasRootTweetId: !!(vars && vars.rootTweetId)
          }, 50);
          if (gql) debugGraphql(gql, operationName);
          if (operationName === 'TweetDetail') setupXhrTweetDetailMerge(this, rawUrl, vars);
        }).catch(() => { /* ignore */ });
      }
    } catch (_) { /* ignore */ }
    return XHRsend.apply(this, arguments);
  };

  // --- query id resolution (baked-in, capture, bundle-scan self-heal) --------
  async function scanBundlesForModeratedId() {
    const reF = /queryId:"([a-zA-Z0-9_-]+)",operationName:"ModeratedTimeline"/;
    const reR = /operationName:"ModeratedTimeline"[^{}]{0,400}?queryId:"([a-zA-Z0-9_-]+)"/;
    const urls = Array.from(document.scripts).map((s) => s.src).filter((s) => s && /abs\.twimg\.com\/.*\.js(\?|$)/.test(s));
    for (const u of urls) {
      try { const t = await origFetch(u, { credentials: 'omit' }).then((r) => r.text()); const m = t.match(reF) || t.match(reR); if (m && m[1]) return m[1]; }
      catch (_) { /* ignore */ }
    }
    return null;
  }
  async function resolveQueryId(forceScan) {
    if (!forceScan) { if (state.ops.ModeratedTimeline) return state.ops.ModeratedTimeline; if (FALLBACK_QUERY_ID) return FALLBACK_QUERY_ID; }
    const scanned = await scanBundlesForModeratedId();
    if (scanned) { state.ops.ModeratedTimeline = scanned; return scanned; }
    return state.ops.ModeratedTimeline || FALLBACK_QUERY_ID || null;
  }

  function buildFeatures() { const o = Object.assign({}, state.featuresObj || {}); for (const k of MODERATED_FEATURES) if (!(k in o)) o[k] = !FEATURE_DEFAULT_FALSE.has(k); return o; }
  function buildFieldToggles() { const o = Object.assign({}, state.fieldTogglesObj || {}); for (const k of MODERATED_FIELD_TOGGLES) if (!(k in o)) o[k] = false; return o; }

  async function doFetch(queryId, rootId) {
    const variables = { rootTweetId: String(rootId), count: 40, includePromotedContent: false };
    const origin = state.graphqlOrigin || location.origin;
    const prefix = state.graphqlPrefix || '/graphql';
    const url = origin + prefix + '/' + queryId + '/ModeratedTimeline' +
      '?variables=' + encodeURIComponent(JSON.stringify(variables)) +
      '&features=' + encodeURIComponent(JSON.stringify(buildFeatures())) +
      '&fieldToggles=' + encodeURIComponent(JSON.stringify(buildFieldToggles()));
    const headers = {
      authorization: state.bearer || FALLBACK_BEARER,
      'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': state.lang || 'en', 'x-csrf-token': getCookie('ct0'),
      'content-type': 'application/json'
    };
    const res = await origFetch(url, { method: 'GET', headers, credentials: 'include', referrer: location.href });
    let json = null; try { json = await res.clone().json(); } catch (_) { /* ignore */ }
    return { res, json };
  }

  function getModerated(rootId) {
    if (!moderatedPromises.has(rootId)) {
      moderatedPromises.set(rootId, fetchModerated(rootId).then((result) => {
        moderatedResults.set(String(rootId), result);
        return result;
      }));
    }
    return moderatedPromises.get(rootId);
  }

  function rememberHiddenThreadReplies(nestedByParent) {
    if (!nestedByParent || typeof nestedByParent.forEach !== 'function') return;
    nestedByParent.forEach((bucket, parentId) => {
      if (!bucket || !Array.isArray(bucket.results) || !bucket.results.length) return;
      const key = String(parentId);
      const existing = hiddenThreadRepliesByParent.get(key) || { results: [], ids: [] };
      const seen = new Set(existing.ids.map(String));
      for (const res of bucket.results) {
        const id = resId(res);
        if (!id || seen.has(String(id))) continue;
        seen.add(String(id));
        existing.results.push(res);
        existing.ids.push(String(id));
      }
      hiddenThreadRepliesByParent.set(key, existing);
    });
  }

  function addCachedThreadReplies(rootId, results, ids) {
    const cached = hiddenThreadRepliesByParent.get(String(rootId));
    if (!cached || !Array.isArray(cached.results) || !cached.results.length) {
      return { results: results, ids: ids, added: 0, addedIds: [] };
    }

    const merged = results.slice();
    const mergedIds = ids.slice();
    const seen = new Set(merged.map(resId).filter(Boolean).map(String));
    const addedIds = [];
    for (const res of cached.results) {
      const id = resId(res);
      if (!id || seen.has(String(id))) continue;
      seen.add(String(id));
      merged.push(res);
      addedIds.push(String(id));
    }

    return { results: merged, ids: mergedIds, added: addedIds.length, addedIds: addedIds };
  }

  function modWithCachedThreadReplies(rootId, mod) {
    const base = mod && mod.ok ? mod : { ok: true, results: [], ids: [] };
    const merged = addCachedThreadReplies(rootId, base.results || [], base.ids || []);
    if (!merged.added && mod && mod.ok) return mod;
    if (!merged.added && (!mod || !mod.ok)) return mod;
    return Object.assign({}, base, {
      ok: true,
      results: merged.results,
      ids: merged.ids,
      threadReplyCount: (base.threadReplyCount || 0) + merged.added,
      threadReplyIds: (base.threadReplyIds || []).concat(merged.addedIds)
    });
  }

  function findTweetResult(json, tweetId) {
    const target = String(tweetId);
    const stack = [json];
    let guard = 0;
    while (stack.length && guard++ < 300000) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      const t = tweetFromResult(n);
      if (t && resId(t) === target) return t;
      if (Array.isArray(n)) {
        for (const v of n) stack.push(v);
        continue;
      }
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  }

  async function recoverHiddenThreadRepliesFromParent(json, rootId, mod) {
    let next = modWithCachedThreadReplies(rootId, mod);
    if (next && next.ok && Array.isArray(next.results) && next.results.length) return next;

    const focal = findTweetResult(json, rootId);
    const parentId = replyParentId(focal);
    if (!parentId || String(parentId) === String(rootId)) return next || mod;

    debugTweet(rootId, { hiddenThreadSourceParentId: String(parentId) });
    await getModerated(String(parentId));
    next = modWithCachedThreadReplies(rootId, mod);
    if (next && next.ok && Array.isArray(next.results) && next.results.length) {
      debugTweet(rootId, { hiddenThreadRecoveredFromParent: true });
      return next;
    }
    return mod;
  }

  async function fetchModerated(rootId) {
    let queryId = await resolveQueryId(false);
    if (!queryId) return { ok: false, error: 'NO_QUERY_ID' };
    try {
      let r = await doFetch(queryId, rootId);
      if (r.res.status === 404) { const fresh = await resolveQueryId(true); if (fresh && fresh !== queryId) { queryId = fresh; r = await doFetch(queryId, rootId); } }
      debugTweet(rootId, { moderatedQueryId: queryId, moderatedStatus: r.res.status, moderatedHasJson: !!r.json });
      if (!r.res.ok || !r.json) return { ok: false, error: 'HTTP_' + r.res.status, status: r.res.status };
      if (r.json.errors && !r.json.data) {
        debugTweet(rootId, { moderatedError: 'GRAPHQL_ERROR', moderatedBody: r.json.errors });
        return { ok: false, error: 'GRAPHQL_ERROR', body: r.json.errors };
      }
      const out = extractResults(r.json, rootId);
      rememberHiddenThreadReplies(out.nestedByParent);
      const merged = addCachedThreadReplies(rootId, out.results, out.ids);
      debugTweet(rootId, {
        moderatedExtracted: out.results.length,
        moderatedFilteredNested: out.filteredNested || 0,
        moderatedCachedThreadReplies: merged.added,
        moderatedCachedThreadReplyIds: merged.addedIds,
        moderatedIds: merged.ids.slice()
      });
      console.log(TAG, 'ModeratedTimeline returned ' + out.results.length + ' hidden repl' + (out.results.length === 1 ? 'y' : 'ies') + ' and ' + merged.added + ' cached thread repl' + (merged.added === 1 ? 'y' : 'ies') + ' for', rootId);
      return { ok: true, results: merged.results, ids: merged.ids, threadReplyCount: merged.added };
    } catch (e) {
      debugTweet(rootId, { moderatedError: 'FETCH_FAILED', moderatedDetail: String((e && e.message) || e) });
      return { ok: false, error: 'FETCH_FAILED', detail: String((e && e.message) || e) };
    }
  }

  function postHiddenIds(rootId) {
    const ids = hiddenIdsByRoot.get(String(rootId));
    if (!ids) return;
    window.postMessage({ source: 'HRX_PAGE', type: 'HIDDEN_IDS', tweetId: String(rootId), ids: ids }, location.origin);
  }

  function rememberHiddenIds(rootId, ids) {
    hiddenIdsByRoot.set(String(rootId), Array.isArray(ids) ? ids.map(String) : []);
    postHiddenIds(rootId);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'HRX_CS') return;

    if (d.type === 'HRX_READY') {
      if (d.tweetId) {
        getModerated(String(d.tweetId));
        postHiddenIds(d.tweetId);
      }
      return;
    }

    if (d.type === 'MARK_STATUS') {
      debugTweet(d.tweetId, {
        markerHiddenIds: d.hiddenIds || 0,
        markerMatchedCells: d.marked || 0,
        markerUpdatedAt: Date.now()
      });
    }
  });

  // --- response parsing & merge ---------------------------------------------
  function tweetFromResult(res) {
    if (!res) return null;
    let t = res;
    if (res.__typename === 'TweetWithVisibilityResults') t = res.tweet;
    if (!t) return null;
    return t;
  }

  function resId(res) {
    const t = tweetFromResult(res);
    if (!t) return null;
    return (t.rest_id || (t.legacy && t.legacy.id_str)) || null;
  }

  function replyParentId(res) {
    const t = tweetFromResult(res);
    const legacy = t && t.legacy;
    return legacy && (legacy.in_reply_to_status_id_str || legacy.in_reply_to_status_id) || null;
  }

  // Collect the hidden replies as plain Tweet results (unwrapped of any
  // visibility wrapper, so X renders them as normal replies) + their ids.
  function extractResults(json, rootId) {
    const results = []; const ids = []; const seen = new Set();
    const nestedByParent = new Map();
    let filteredNested = 0;
    const addNested = (parentId, res) => {
      const id = resId(res);
      if (!parentId || !id) return false;
      const key = String(parentId);
      const bucket = nestedByParent.get(key) || { results: [], ids: [], seen: new Set() };
      if (bucket.seen.has(String(id))) return false;
      bucket.seen.add(String(id));
      bucket.results.push(res);
      bucket.ids.push(String(id));
      nestedByParent.set(key, bucket);
      return true;
    };
    const add = (res, fromDeepScan) => {
      const t = tweetFromResult(res);
      if (!t || t.__typename === 'TweetTombstone') return;
      const id = resId(t);
      if (!id || String(id) === String(rootId) || seen.has(id)) return;
      const parentId = replyParentId(t);
      if (parentId && String(parentId) !== String(rootId)) {
        if (addNested(parentId, t)) filteredNested++;
        return;
      }
      if (fromDeepScan && !parentId) return;
      seen.add(id); results.push(t); ids.push(String(id));
    };
    const visit = (entry) => {
      if (!entry || typeof entry !== 'object') return;
      if (/cursor/i.test(entry.entryId || '')) return;
      const c = entry.content || entry.item || {};
      const items = c.items || (c.content && c.content.items);
      if (Array.isArray(items)) { for (const it of items) { const ic = (it.item && it.item.itemContent) || it.itemContent; if (ic && ic.tweet_results) add(ic.tweet_results.result, false); } return; }
      const ic = c.itemContent || (c.content && c.content.itemContent);
      if (ic && ic.tweet_results) add(ic.tweet_results.result, false);
    };
    const stack = [json];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { for (const v of n) stack.push(v); continue; }
      for (const k in n) { const v = n[k]; if (k === 'entries' && Array.isArray(v)) for (const e of v) visit(e); if (v && typeof v === 'object') stack.push(v); }
    }
    const beforeDeepResults = results.length;
    const beforeDeepNested = filteredNested;
    const stack2 = [json];
    let guard = 0;
    while (stack2.length && guard++ < 300000) {
      const n = stack2.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) {
        for (const v of n) stack2.push(v);
        continue;
      }
      if (n.__typename === 'TweetWithVisibilityResults' || ((n.__typename === 'Tweet' || n.rest_id) && (n.legacy || n.core))) add(n, true);
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === 'object') stack2.push(v);
      }
    }
    if (results.length > beforeDeepResults || filteredNested > beforeDeepNested) {
      console.log(TAG, 'deep scan added ' + (results.length - beforeDeepResults) + ' hidden repl' + (results.length - beforeDeepResults === 1 ? 'y' : 'ies') + ' and cached ' + (filteredNested - beforeDeepNested) + ' nested repl' + (filteredNested - beforeDeepNested === 1 ? 'y' : 'ies'));
    }
    nestedByParent.forEach((bucket) => { delete bucket.seen; });
    return { results, ids, filteredNested, nestedByParent };
  }

  function entryContainsTweet(entry, tweetId) {
    if (!entry || !tweetId) return false;
    if (typeof entry.entryId === 'string' && entry.entryId.indexOf(String(tweetId)) !== -1) return true;
    if (itemContentId(itemContentFromEntry(entry)) === String(tweetId)) return true;
    const c = entry.content || {};
    const items = c.items || (c.content && c.content.items);
    if (Array.isArray(items)) {
      for (const it of items) if (itemContentId(itemContentFromModuleItem(it)) === String(tweetId)) return true;
    }
    return false;
  }

  function findAddInstruction(json, rootId) {
    const direct =
      json && json.data &&
      json.data.threaded_conversation_with_injections_v2 &&
      Array.isArray(json.data.threaded_conversation_with_injections_v2.instructions)
        ? json.data.threaded_conversation_with_injections_v2.instructions
        : null;
    if (direct) {
      let directFallback = null;
      for (const ins of direct) {
        if (!Array.isArray(ins.entries)) continue;
        if (!directFallback) directFallback = ins;
        if (ins.entries.some((entry) => entryContainsTweet(entry, rootId))) return ins;
      }
      if (directFallback) return directFallback;
    }

    let best = null; let fallback = null; const stack = [json];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { for (const v of n) stack.push(v); continue; }
      if (Array.isArray(n.instructions)) {
        for (const ins of n.instructions) {
          if (!Array.isArray(ins.entries)) continue;
          if (!fallback || ins.entries.length > fallback.entries.length) fallback = ins;
          if (ins.entries.some((entry) => entryContainsTweet(entry, rootId)) && (!best || ins.entries.length > best.entries.length)) best = ins;
        }
      }
      for (const k in n) if (n[k] && typeof n[k] === 'object') stack.push(n[k]);
    }
    return best || fallback;
  }

  function decStr(base, n) { try { if (typeof base !== 'string' || !/^\d+$/.test(base)) return null; return (BigInt(base) - BigInt(n)).toString(); } catch (_) { return null; } }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function itemContentFromEntry(entry) {
    const c = entry && entry.content;
    return c && (c.itemContent || (c.content && c.content.itemContent)) || null;
  }

  function itemContentFromModuleItem(item) {
    return item && ((item.item && item.item.itemContent) || item.itemContent) || null;
  }

  function itemContentId(itemContent) {
    return itemContent && itemContent.tweet_results && resId(itemContent.tweet_results.result);
  }

  function tweetResultForTemplate(templateResult, res) {
    const renderTweet = clone(tweetFromResult(res));
    if (templateResult && templateResult.__typename === 'TweetWithVisibilityResults') {
      const wrapper = clone(templateResult);
      rewriteTemplateIdRefs(wrapper, resId(templateResult), resId(res));
      wrapper.tweet = renderTweet;
      if (wrapper.limitedActionResults) delete wrapper.limitedActionResults;
      return wrapper;
    }
    return renderTweet;
  }

  function replyItemContent(template, res) {
    const itemContent = template ? clone(template) : { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweetDisplayType: 'Tweet' };
    const templateResult = template && template.tweet_results && template.tweet_results.result;
    itemContent.tweet_results = { result: tweetResultForTemplate(templateResult, res) };
    itemContent.itemType = itemContent.itemType || 'TimelineTweet';
    itemContent.__typename = itemContent.__typename || 'TimelineTweet';
    itemContent.tweetDisplayType = itemContent.tweetDisplayType || 'Tweet';
    if (itemContent.socialContext) delete itemContent.socialContext;
    return itemContent;
  }

  function replaceEntryTweet(entry, res) {
    const c = entry && entry.content;
    if (!c) return false;
    if (c.itemContent) {
      c.itemContent = replyItemContent(c.itemContent, res);
      return true;
    }
    if (c.content && c.content.itemContent) {
      c.content.itemContent = replyItemContent(c.content.itemContent, res);
      return true;
    }
    return false;
  }

  function entryIdFor(templateId, id) {
    if (typeof templateId === 'string' && /tweet-\d+/.test(templateId)) {
      return templateId.replace(/tweet-\d+/, 'tweet-' + id);
    }
    return 'tweet-' + id;
  }

  function rewriteTemplateIdRefs(node, oldId, newId) {
    if (!oldId || !newId || String(oldId) === String(newId)) return node;
    if (typeof node === 'string') {
      return node.split(String(oldId)).join(String(newId));
    }
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = rewriteTemplateIdRefs(node[i], oldId, newId);
      return node;
    }
    for (const k in node) node[k] = rewriteTemplateIdRefs(node[k], oldId, newId);
    return node;
  }

  function collectEntryTweetIds(entries) {
    const ids = new Set();
    for (const e of entries) {
      const id = itemContentId(itemContentFromEntry(e));
      if (id) ids.add(String(id));
      const c = e && e.content;
      const items = c && (c.items || (c.content && c.content.items));
      if (Array.isArray(items)) {
        for (const it of items) {
          const mid = itemContentId(itemContentFromModuleItem(it));
          if (mid) ids.add(String(mid));
        }
      }
    }
    return ids;
  }

  function findFocalEntryIndex(entries, rootId) {
    return entries.findIndex((entry) => entryContainsTweet(entry, rootId));
  }

  function findReplyModuleTemplate(entries, rootId) {
    const focalIndex = findFocalEntryIndex(entries, rootId);
    for (let entryIndex = Math.max(0, focalIndex + 1); entryIndex < entries.length; entryIndex++) {
      const e = entries[entryIndex];
      const c = e && e.content;
      const items = c && (c.items || (c.content && c.content.items));
      if (!Array.isArray(items)) continue;
      for (let i = 0; i < items.length; i++) {
        const id = itemContentId(itemContentFromModuleItem(items[i]));
        if (id && String(id) !== String(rootId)) return { entry: e, entryIndex: entryIndex, items: items, index: i, template: items[i] };
      }
    }
    return null;
  }

  function replyEntryAnchors(entries, rootId) {
    const out = [];
    const focalIndex = findFocalEntryIndex(entries, rootId);
    for (let i = Math.max(0, focalIndex + 1); i < entries.length; i++) {
      const id = itemContentId(itemContentFromEntry(entries[i]));
      if (id && String(id) !== String(rootId)) out.push({ entry: entries[i], index: i, id: String(id) });
    }
    return out;
  }

  function makeTimelineEntry(template, res, baseSort, offset, rootId) {
    const id = resId(res);
    const oldId = itemContentId(itemContentFromEntry(template));
    const entry = template ? clone(template) : {
      content: {
        entryType: 'TimelineTimelineItem',
        __typename: 'TimelineTimelineItem',
        itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweetDisplayType: 'Tweet' }
      }
    };
    if (String(oldId) !== String(rootId)) rewriteTemplateIdRefs(entry, oldId, id);
    entry.entryId = entryIdFor(entry.entryId, id);
    if (!replaceEntryTweet(entry, res)) {
      entry.content = {
        entryType: 'TimelineTimelineItem',
        __typename: 'TimelineTimelineItem',
        itemContent: replyItemContent(null, res)
      };
    }
    const sort = decStr(baseSort, offset);
    if (sort) entry.sortIndex = sort; else if (baseSort) entry.sortIndex = baseSort;
    return entry;
  }

  function makeModuleItem(templateItem, res, rootId) {
    const id = resId(res);
    const oldId = itemContentId(itemContentFromModuleItem(templateItem));
    const item = templateItem ? clone(templateItem) : { entryId: 'tweet-' + id, item: {} };
    if (oldId && String(oldId) !== String(rootId)) rewriteTemplateIdRefs(item, oldId, id);
    item.entryId = entryIdFor(item.entryId, id);
    if (item.item && item.item.itemContent) {
      item.item.itemContent = replyItemContent(item.item.itemContent, res);
    } else if (item.itemContent) {
      item.itemContent = replyItemContent(item.itemContent, res);
    } else {
      item.item = item.item || {};
      item.item.itemContent = replyItemContent(null, res);
    }
    return item;
  }

  function makeModuleItemFromEntry(templateEntry, res, rootId) {
    const id = resId(res);
    const templateContent = itemContentFromEntry(templateEntry);
    const item = {
      entryId: 'tweet-' + id,
      item: {
        itemContent: replyItemContent(templateContent, res)
      }
    };
    const c = templateEntry && templateEntry.content;
    const clientEventInfo = c && (c.clientEventInfo || (c.content && c.content.clientEventInfo));
    if (clientEventInfo) item.item.clientEventInfo = clone(clientEventInfo);
    if (String(itemContentId(templateContent)) !== String(rootId)) rewriteTemplateIdRefs(item, itemContentId(templateContent), id);
    item.entryId = entryIdFor(item.entryId, id);
    return item;
  }

  function moduleItemsPath(entry) {
    const c = entry && entry.content;
    if (c && Array.isArray(c.items)) return { holder: c, key: 'items', items: c.items };
    if (c && c.content && Array.isArray(c.content.items)) return { holder: c.content, key: 'items', items: c.content.items };
    return null;
  }

  function moduleItemIds(items) {
    const ids = [];
    if (!Array.isArray(items)) return ids;
    for (const item of items) {
      const id = itemContentId(itemContentFromModuleItem(item));
      if (id) ids.push(String(id));
    }
    return ids;
  }

  function replaceTweetIdArrays(node, ids) {
    if (!node || typeof node !== 'object' || !Array.isArray(ids)) return;
    const nextIds = ids.map(String);
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) {
        for (const v of n) if (v && typeof v === 'object') stack.push(v);
        continue;
      }
      for (const k in n) {
        const v = n[k];
        if (/tweetids$/i.test(k) && Array.isArray(v)) {
          n[k] = nextIds.slice();
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
    }
  }

  function moduleSegment(entry, items, baseSort, offset, suffix) {
    const segment = clone(entry);
    if (suffix) segment.entryId = String(entry.entryId || 'conversationthread') + '-hrx-' + suffix;
    const path = moduleItemsPath(segment);
    if (!path) return null;
    path.holder[path.key] = items.map(clone);
    replaceTweetIdArrays(segment, moduleItemIds(path.holder[path.key]));
    const sort = offset === 0 ? baseSort : decStr(baseSort, offset);
    if (sort) segment.sortIndex = sort; else if (baseSort) segment.sortIndex = baseSort;
    return segment;
  }

  function upperAnchorIndexes(count, hiddenCount) {
    if (count <= 0 || hiddenCount <= 0) return [];
    const upperCount = Math.min(count, Math.max(6, hiddenCount * 2));
    const out = [];
    for (let i = 0; i < hiddenCount; i++) {
      const idx = Math.min(upperCount - 1, Math.floor(((i + 1) * upperCount) / (hiddenCount + 1)));
      out.push(idx);
    }
    return out;
  }

  function splitModuleWithHiddenItems(entries, moduleTemplate, fresh, rootId) {
    const items = moduleTemplate && moduleTemplate.items;
    if (!Array.isArray(items) || !items.length) return false;
    const anchors = upperAnchorIndexes(items.length, fresh.length);
    const byAnchor = new Map();
    fresh.forEach((res, i) => {
      const anchor = anchors[i];
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
      byAnchor.get(anchor).push(res);
    });

    const pieces = [];
    const groups = Array.from(byAnchor.entries()).sort((a, b) => a[0] - b[0]);
    const baseSort = moduleTemplate.entry && moduleTemplate.entry.sortIndex;
    let start = 0;
    let segmentIndex = 0;
    let pieceOffset = 0;

    for (const group of groups) {
      const anchor = Math.min(items.length - 1, Math.max(0, group[0]));
      const end = Math.max(start, anchor + 1);
      if (end > start) {
        const segment = moduleSegment(moduleTemplate.entry, items.slice(start, end), baseSort, pieceOffset, segmentIndex ? 'segment-' + segmentIndex : '');
        if (!segment) return false;
        pieces.push(segment);
        segmentIndex++;
        pieceOffset++;
      }
      for (const res of group[1]) {
        const hiddenSegment = moduleSegment(moduleTemplate.entry, [makeModuleItem(moduleTemplate.template, res, rootId)], baseSort, pieceOffset, 'hidden-' + resId(res));
        if (!hiddenSegment) return false;
        pieces.push(hiddenSegment);
        pieceOffset++;
      }
      start = end;
    }

    if (start < items.length) {
      const segment = moduleSegment(moduleTemplate.entry, items.slice(start), baseSort, pieceOffset, segmentIndex ? 'segment-' + segmentIndex : '');
      if (!segment) return false;
      pieces.push(segment);
    }

    if (!pieces.length) return false;
    entries.splice(moduleTemplate.entryIndex, 1, ...pieces);
    return true;
  }

  function insertStandaloneHiddenAfterAnchors(entries, anchors, fresh, rootId) {
    if (!anchors.length) return false;
    const anchorSlots = upperAnchorIndexes(anchors.length, fresh.length);
    const byAnchor = new Map();
    fresh.forEach((res, i) => {
      const anchor = anchors[anchorSlots[i]];
      if (!anchor) return;
      if (!byAnchor.has(anchor.index)) byAnchor.set(anchor.index, { anchor: anchor, results: [] });
      byAnchor.get(anchor.index).results.push(res);
    });

    const groups = Array.from(byAnchor.values()).sort((a, b) => b.anchor.index - a.anchor.index);
    for (const group of groups) {
      const baseSort = group.anchor.entry.sortIndex;
      const newEntries = group.results.map((res, i) => makeTimelineEntry(group.anchor.entry, res, baseSort, i + 1, rootId));
      entries.splice(group.anchor.index + 1, 0, ...newEntries);
    }
    return true;
  }

  function makeModuleFromEntryTemplate(templateEntry, fresh, baseSort, offset, rootId) {
    if (!templateEntry || !fresh.length) return null;
    const ids = fresh.map(resId).filter(Boolean).map(String);
    const entry = {
      entryId: 'conversationthread-' + rootId + '-hrx-' + ids.join('-'),
      content: {
        entryType: 'TimelineTimelineModule',
        __typename: 'TimelineTimelineModule',
        displayType: 'VerticalConversation',
        items: fresh.map((res) => makeModuleItemFromEntry(templateEntry, res, rootId))
      }
    };
    const sort = decStr(baseSort, offset);
    if (sort) entry.sortIndex = sort; else if (baseSort) entry.sortIndex = baseSort;
    replaceTweetIdArrays(entry, ids);
    return entry;
  }

  function insertModuleHiddenAfterFocal(entries, focalIndex, fresh, rootId) {
    const focal = entries[focalIndex];
    if (!focal || !fresh.length) return false;
    const baseSort = focal.sortIndex;
    const module = makeModuleFromEntryTemplate(focal, fresh, baseSort, 1, rootId);
    if (!module) return false;
    entries.splice(focalIndex + 1, 0, module);
    return true;
  }

  function mergeHidden(json, results, rootId, options) {
    const instr = findAddInstruction(json, rootId);
    if (!instr || !Array.isArray(instr.entries)) return false;
    const entries = instr.entries;
    const existing = collectEntryTweetIds(entries);
    const fresh = results.filter((res) => {
      const id = resId(res);
      return id && !existing.has(String(id));
    });
    if (!fresh.length) return true;

    const moduleTemplate = findReplyModuleTemplate(entries, rootId);
    if (moduleTemplate) {
      const newIds = fresh.map(resId).filter(Boolean).map(String);
      if (!splitModuleWithHiddenItems(entries, moduleTemplate, fresh, rootId)) return false;
      debugTweet(rootId, { mergeMode: 'module-split-items', mergeFreshCount: fresh.length, mergeIds: newIds });
      console.log(TAG, 'spaced ' + fresh.length + ' hidden repl' + (fresh.length === 1 ? 'y' : 'ies') + ' as native X reply module items');
      return true;
    }

    const anchors = replyEntryAnchors(entries, rootId);
    if (!anchors.length) {
      if (options && options.allowFocalFallback) {
        const focalIndex = findFocalEntryIndex(entries, rootId);
        if (focalIndex !== -1 && insertModuleHiddenAfterFocal(entries, focalIndex, fresh, rootId)) {
          debugTweet(rootId, { mergeMode: 'focal-module-fallback', mergeFreshCount: fresh.length, mergeIds: fresh.map(resId).filter(Boolean).map(String) });
          console.log(TAG, 'inserted ' + fresh.length + ' hidden-thread repl' + (fresh.length === 1 ? 'y' : 'ies') + ' in a native X reply module while waiting for reply templates');
          return true;
        }
      }
      debugTweet(rootId, { mergeSkipped: 'WAITING_FOR_REPLY_TEMPLATE' });
      console.log(TAG, 'hidden replies fetched; waiting for X to load real reply templates before splicing');
      return 'WAITING_FOR_REPLY_TEMPLATE';
    }
    if (!insertStandaloneHiddenAfterAnchors(entries, anchors, fresh, rootId)) return false;
    debugTweet(rootId, { mergeMode: 'entries-spaced', mergeFreshCount: fresh.length, mergeIds: fresh.map(resId).filter(Boolean).map(String) });
    console.log(TAG, 'spaced ' + fresh.length + ' hidden repl' + (fresh.length === 1 ? 'y' : 'ies') + ' through the upper X timeline entries');
    return true;
  }

  async function mergeIntoTweetDetail(res, rootId) {
    try {
      const json = await res.clone().json();
      let mod = await getModerated(rootId);
      mod = await recoverHiddenThreadRepliesFromParent(json, rootId, mod);
      if (!applyHiddenToTweetDetailJson(json, rootId, mod)) return res;
      const h = new Headers(res.headers); h.delete('content-length'); h.delete('content-encoding'); h.set('content-type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: h });
    } catch (e) {
      try { console.warn(TAG, 'merge error:', (e && e.message) || e); } catch (_) { /* ignore */ }
      return res;
    }
  }

  console.log('%c[HiddenReplies]', 'color:#f59e0b;font-weight:bold', 'page hook installed (TweetDetail merge active)');
})();
