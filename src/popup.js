(() => {
  'use strict';

  const SETTINGS_KEY = 'hrxSettings';
  const DEFAULT_SETTINGS = { disabledAccounts: [], disableOwnAccount: false, ownAccount: '' };
  const hasChromeApi = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  const state = {
    settings: DEFAULT_SETTINGS,
    activeAccount: null,
    ownAccount: null,
    activeTabId: null,
    saveTimer: null
  };

  const els = {
    contextLabel: document.getElementById('contextLabel'),
    ownToggle: document.getElementById('ownToggle'),
    ownSubtitle: document.getElementById('ownSubtitle'),
    addForm: document.getElementById('addForm'),
    accountInput: document.getElementById('accountInput'),
    addButton: document.getElementById('addButton'),
    accountList: document.getElementById('accountList'),
    emptyState: document.getElementById('emptyState'),
    statusText: document.getElementById('statusText')
  };

  function normalizeScreenName(value) {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function displayName(value) {
    const key = normalizeScreenName(value);
    return key ? '@' + key : '';
  }

  function isReservedPath(name) {
    return /^(home|explore|notifications|messages|i|settings|compose|search|jobs|login|logout|signup|tos|privacy)$/i.test(String(name || ''));
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

  function screenNameFromUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(u.hostname)) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;

      const key = normalizeScreenName(parts[0]);
      if (!key || isReservedPath(key)) return null;

      const section = String(parts[1] || '').toLowerCase();
      if (section === 'status' && /^\d+$/.test(String(parts[2] || ''))) return key;
      if (parts.length === 1) return key;
      if (/^(with_replies|media|likes|highlights|articles|followers|following|verified_followers)$/.test(section)) return key;
      return null;
    } catch (_) {
      return null;
    }
  }

  function usableActiveAccount(account, ownAccount) {
    const key = normalizeScreenName(account);
    const own = normalizeScreenName(ownAccount);
    return key && key !== own ? key : null;
  }

  function addTargetAccount() {
    return normalizeScreenName(els.accountInput.value) || state.activeAccount || '';
  }

  function isAccountAlreadyDisabled(account) {
    const key = normalizeScreenName(account);
    return !!key && state.settings.disabledAccounts.indexOf(key) !== -1;
  }

  function updateAddState() {
    const target = addTargetAccount();
    els.addButton.disabled = !target || isAccountAlreadyDisabled(target);
  }

  function storageGet() {
    if (!hasChromeApi) {
      return Promise.resolve({
        disabledAccounts: ['example_author', 'clock_hypocrisy', 'carlevyofficial', 'kamalithegoat', 'imfynertanfyne', 'sixth_example'],
        disableOwnAccount: true,
        ownAccount: 'myaccount'
      });
    }
    return new Promise((resolve) => {
      chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (items) => {
        resolve(items && items[SETTINGS_KEY]);
      });
    });
  }

  function storageSet(settings) {
    if (!hasChromeApi) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, resolve);
    });
  }

  function queryActiveTab() {
    if (!hasChromeApi || !chrome.tabs || !chrome.tabs.query) {
      return Promise.resolve({ id: null, url: 'https://x.com/example_author/status/123' });
    }
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] || null);
      });
    });
  }

  function getTabContext(tab) {
    if (!hasChromeApi || !chrome.tabs || !chrome.tabs.sendMessage || !tab || !tab.id) {
      return Promise.resolve({
        context: { screenName: screenNameFromUrl(tab && tab.url), ownAccount: 'myaccount' },
        settings: null
      });
    }
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { source: 'HRX_POPUP', type: 'GET_CONTEXT' }, (response) => {
        if (chrome.runtime.lastError || !response || response.ok !== true) {
          resolve({ context: { screenName: screenNameFromUrl(tab.url), ownAccount: null }, settings: null });
          return;
        }
        resolve(response);
      });
    });
  }

  function notifyActiveTab() {
    if (!hasChromeApi || !chrome.tabs || !chrome.tabs.sendMessage || !state.activeTabId) return;
    chrome.tabs.sendMessage(state.activeTabId, { source: 'HRX_POPUP', type: 'SETTINGS_CHANGED' }, () => {
      void chrome.runtime.lastError;
    });
  }

  function setStatus(text) {
    els.statusText.textContent = text;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      els.statusText.textContent = 'Changes apply on the next X page load.';
    }, 1800);
  }

  async function save(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    if (!normalized.ownAccount && state.ownAccount) normalized.ownAccount = state.ownAccount;
    state.settings = normalized;
    await storageSet(state.settings);
    notifyActiveTab();
    render();
    setStatus('Saved.');
  }

  function addAccount(account) {
    const key = normalizeScreenName(account);
    if (!key) return;
    if (isAccountAlreadyDisabled(key)) {
      updateAddState();
      return;
    }
    const disabledAccounts = state.settings.disabledAccounts.slice();
    disabledAccounts.push(key);
    void save(Object.assign({}, state.settings, { disabledAccounts: disabledAccounts }));
  }

  function removeAccount(account) {
    const key = normalizeScreenName(account);
    const disabledAccounts = state.settings.disabledAccounts.filter((item) => item !== key);
    void save(Object.assign({}, state.settings, { disabledAccounts: disabledAccounts }));
  }

  function renderContext() {
    const account = state.activeAccount;
    if (!account) {
      els.contextLabel.textContent = 'Settings';
      els.accountInput.placeholder = '@account';
      updateAddState();
      return;
    }
    els.contextLabel.textContent = 'Current: ' + displayName(account);
    els.accountInput.placeholder = 'Current: ' + displayName(account);
    updateAddState();
  }

  function renderAccountList() {
    els.accountList.textContent = '';
    const accounts = state.settings.disabledAccounts.slice().sort();
    els.emptyState.hidden = accounts.length > 0;
    els.accountList.classList.toggle('isScrollable', accounts.length > 5);
    for (const account of accounts) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      const button = document.createElement('button');
      label.textContent = displayName(account);
      button.type = 'button';
      button.textContent = 'Remove';
      button.addEventListener('click', () => removeAccount(account));
      li.append(label, button);
      els.accountList.append(li);
    }
  }

  function render() {
    renderContext();
    els.ownToggle.checked = state.settings.disableOwnAccount;
    const ownAccount = state.ownAccount || state.settings.ownAccount;
    els.ownSubtitle.textContent = ownAccount
      ? 'Detected as ' + displayName(ownAccount) + '. Hidden replies will not be merged on your posts.'
      : 'Open X while logged in so the extension can detect your account.';
    renderAccountList();
  }

  function bindEvents() {
    els.ownToggle.addEventListener('change', () => {
      void save(Object.assign({}, state.settings, {
        disableOwnAccount: els.ownToggle.checked,
        ownAccount: state.ownAccount || state.settings.ownAccount
      }));
    });

    els.addForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const target = addTargetAccount();
      if (!target) {
        updateAddState();
        return;
      }
      addAccount(target);
      els.accountInput.value = '';
      updateAddState();
      els.accountInput.focus();
    });

    els.accountInput.addEventListener('input', updateAddState);
  }

  async function init() {
    bindEvents();
    const tab = await queryActiveTab();
    state.activeTabId = tab && tab.id || null;
    const contextResponse = await getTabContext(tab);
    const context = contextResponse && contextResponse.context || {};
    const storedSettings = normalizeSettings(await storageGet());
    const contentSettings = normalizeSettings(contextResponse && contextResponse.settings);
    state.ownAccount = normalizeScreenName(context.ownAccount) || contentSettings.ownAccount || storedSettings.ownAccount;
    state.activeAccount = usableActiveAccount(
      normalizeScreenName(context.screenName) || screenNameFromUrl(tab && tab.url),
      state.ownAccount
    );
    state.settings = normalizeSettings(Object.assign({}, storedSettings, {
      ownAccount: state.ownAccount
    }));
    render();
  }

  void init();
})();
