/**
 * Google Flow Unlocker - Firefox Background Script
 * Uses native Firefox webRequest.filterResponseData() stream interception.
 * Completely transparent, zero-overhead, no DevTools / debugger banners!
 */

const FLOW_HOME = "https://flow.google.com/";
const FLOW_HOST = "flow.google.com";
const FLOW_URL_PATTERN = /^https:\/\/flow\.google\.com\//;
const TARGET_HOST = "www.gstatic.com";
const TARGET_BUNDLE_MARKER = "AiSandboxAngularFrontend";
const TARGET_BUNDLE_SUFFIX = "/m=_b";
const UNSUPPORTED_REDIRECT_COOLDOWN_MS = 15000;
const SUCCESS_BADGE_MS = 3000;

const lastUnsupportedRedirectAt = new Map();
let enabled = true;

const logsHistory = [];
function addLog(level, message, data = null) {
  const time = new Date().toLocaleTimeString();
  const entry = { time, level, message, data };
  logsHistory.push(entry);
  if (logsHistory.length > 100) {
    logsHistory.shift();
  }

  const prefix = `[FlowUnlocker-FF ${time}]`;
  if (level === "error") {
    if (data !== null) console.error(prefix, "❌", message, data);
    else console.error(prefix, "❌", message);
  } else if (level === "warn") {
    if (data !== null) console.warn(prefix, "⚠️", message, data);
    else console.warn(prefix, "⚠️", message);
  } else {
    if (data !== null) console.log(prefix, message, data);
    else console.log(prefix, message);
  }
}

function isRussianLocale() {
  try {
    const lang = (browser.i18n && browser.i18n.getUILanguage()) || "";
    return lang.toLowerCase().startsWith("ru");
  } catch {
    return false;
  }
}

function getStatusConfig(statusName) {
  const isRu = isRussianLocale();
  const STATUS_CONFIGS = {
    OFF: {
      text: isRu ? "ВЫКЛ" : "OFF",
      color: "#5f6368",
      title: isRu ? "Flow Unlocker: ВЫКЛ. Нажмите для включения." : "Flow Unlocker: OFF. Click to enable."
    },
    ON: {
      text: isRu ? "ВКЛ" : "ON",
      color: "#1a73e8",
      title: isRu ? "Flow Unlocker: ВКЛ. Вкладки Flow обрабатываются автоматически." : "Flow Unlocker: ON. Ready."
    },
    RUN: {
      text: isRu ? "РАБ" : "RUN",
      color: "#f9ab00",
      title: isRu ? "Снятие ограничений Flow..." : "Unlocking Flow bundle..."
    },
    OK: {
      text: isRu ? "ГОТ" : "OK",
      color: "#188038",
      title: isRu ? "Flow успешно разблокирован." : "Flow successfully unlocked."
    },
    ERR: {
      text: isRu ? "ОШБ" : "ERR",
      color: "#d93025",
      title: isRu ? "Ошибка Flow Unlocker." : "Flow Unlocker error."
    }
  };
  return STATUS_CONFIGS[statusName] || STATUS_CONFIGS.ON;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function setStatus(tabId, statusName, detail) {
  const status = getStatusConfig(statusName);
  const target = Number.isInteger(tabId) ? { tabId } : {};
  const title = detail ? `${status.title} ${detail}` : status.title;

  addLog(
    statusName === "ERR" ? "error" : "info",
    `Status [${statusName}] for tab ${tabId ?? "all"}${detail ? ` (${detail})` : ""}`
  );

  try {
    await Promise.all([
      browser.action.setBadgeBackgroundColor({ ...target, color: status.color }),
      browser.action.setBadgeText({ ...target, text: status.text }),
      browser.action.setTitle({ ...target, title })
    ]);
  } catch {
    // Ignore
  }
}

async function setModeStatus() {
  await setStatus(undefined, enabled ? "ON" : "OFF");
}

function isFlowUrl(url) {
  return FLOW_URL_PATTERN.test(url || "");
}

function isUnsupportedCountryUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === FLOW_HOST &&
      /\/(?:unsupported-country)\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function redirectedRecently(tabId) {
  const lastRedirect = lastUnsupportedRedirectAt.get(tabId) || 0;
  return Date.now() - lastRedirect < UNSUPPORTED_REDIRECT_COOLDOWN_MS;
}

function isTargetBundle(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === TARGET_HOST || parsed.hostname.endsWith(".gstatic.com")) &&
      parsed.pathname.includes(TARGET_BUNDLE_MARKER) &&
      (parsed.pathname.endsWith(TARGET_BUNDLE_SUFFIX) || parsed.pathname.includes(TARGET_BUNDLE_SUFFIX))
    );
  } catch {
    return false;
  }
}

// 1. Intercept stream in onBeforeRequest using Firefox filterResponseData API
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!enabled || !isTargetBundle(details.url)) {
      return {};
    }

    addLog("info", `🎯 TARGET BUNDLE DETECTED in Firefox onBeforeRequest! URL: ${details.url}`);
    if (Number.isInteger(details.tabId)) {
      setStatus(details.tabId, "RUN", "Патчинг скрипта Flow...");
    }

    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const decoder = new TextDecoder("utf-8");
      const encoder = new TextEncoder();
      const chunks = [];

      filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
      };

      filter.onstop = async () => {
        try {
          addLog("info", `Stream finished, received ${chunks.length} chunks. Decoding...`);
          let totalLength = 0;
          for (const c of chunks) totalLength += c.length;
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }

          const sourceText = decoder.decode(merged);
          addLog("info", `Bundle decoded (${sourceText.length} chars). Applying FlowPatch...`);

          const patchResult = (globalThis.FlowPatch || globalThis.BezmezhauPatch).patchSource(sourceText);

          if (!patchResult.ok) {
            throw new Error(patchResult.error);
          }

          const patchedBytes = encoder.encode(patchResult.source);
          filter.write(patchedBytes);
          filter.close();

          addLog("info", `✅ Firefox stream filter: patched bundle written & delivered (${patchedBytes.length} bytes)!`);

          await browser.storage.local.set({
            lastError: null,
            lastPatchedUrl: details.url,
            lastRunAt: new Date().toISOString()
          });

          if (Number.isInteger(details.tabId)) {
            await setStatus(details.tabId, "OK", "Разблокировано!");
            setTimeout(() => {
              if (enabled) void setStatus(details.tabId, "ON");
            }, SUCCESS_BADGE_MS);
          }
        } catch (err) {
          addLog("error", `Error patching Firefox stream: ${errorMessage(err)}`);
          // Fallback: write original chunks
          try {
            for (const c of chunks) filter.write(c);
            filter.close();
          } catch {
            // Ignore
          }
          await browser.storage.local.set({
            lastError: errorMessage(err),
            lastRunAt: new Date().toISOString()
          });
          if (Number.isInteger(details.tabId)) {
            await setStatus(details.tabId, "ERR", errorMessage(err));
          }
        }
      };

      filter.onerror = (err) => {
        addLog("error", `filter.onerror: ${errorMessage(err)}`);
      };
    } catch (err) {
      addLog("error", `Failed to attach filterResponseData: ${errorMessage(err)}`);
    }

    return {};
  },
  {
    urls: [
      "*://www.gstatic.com/*AiSandboxAngularFrontend*/m=_b*"
    ]
  },
  ["blocking"]
);

// 2. Strip cache and content-length headers so Firefox always processes clean modified stream
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!enabled || !isTargetBundle(details.url)) {
      return {};
    }

    const headers = (details.responseHeaders || []).filter(
      (h) => !["age", "cache-control", "etag", "expires", "content-length"].includes(h.name.toLowerCase())
    );
    headers.push({ name: "Cache-Control", value: "no-store, no-cache, must-revalidate" });
    headers.push({ name: "Pragma", value: "no-cache" });

    return { responseHeaders: headers };
  },
  {
    urls: [
      "*://www.gstatic.com/*AiSandboxAngularFrontend*/m=_b*"
    ]
  },
  ["blocking", "responseHeaders"]
);

// 3. Catch redirects to /unsupported-country and return to Flow Home
function handleUnsupportedUrl(tabId, url) {
  if (!enabled || !Number.isInteger(tabId) || !isUnsupportedCountryUrl(url)) return;
  if (redirectedRecently(tabId)) return;

  lastUnsupportedRedirectAt.set(tabId, Date.now());
  addLog("warn", `Detected /unsupported-country on tab ${tabId}. Redirecting to Flow Home...`);
  browser.tabs.update(tabId, { url: FLOW_HOME }).catch(() => {});
}

browser.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    if (isUnsupportedCountryUrl(details.url)) {
      handleUnsupportedUrl(details.tabId, details.url);
    }
  },
  { url: [{ schemes: ["https"], hostEquals: FLOW_HOST }] }
);

browser.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId === 0) {
      handleUnsupportedUrl(details.tabId, details.url);
    }
  },
  { url: [{ schemes: ["https"], hostEquals: FLOW_HOST }] }
);

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && isUnsupportedCountryUrl(changeInfo.url)) {
    handleUnsupportedUrl(tabId, changeInfo.url);
  }
});

async function chooseFlowTab(clickedTab) {
  if (Number.isInteger(clickedTab?.id) && isFlowUrl(clickedTab.url)) {
    return clickedTab;
  }

  const existingTabs = await browser.tabs.query({ url: `${FLOW_HOME}*` });
  if (existingTabs.length > 0 && Number.isInteger(existingTabs[0].id)) {
    await browser.tabs.update(existingTabs[0].id, { active: true });
    if (Number.isInteger(existingTabs[0].windowId)) {
      await browser.windows.update(existingTabs[0].windowId, { focused: true });
    }
    return existingTabs[0];
  }

  return browser.tabs.create({ active: true, url: FLOW_HOME });
}

async function setEnabledMode(targetEnabled) {
  const stored = await browser.storage.local.get("enabled");
  const current = stored.enabled === true;
  enabled = typeof targetEnabled === "boolean" ? targetEnabled : !current;
  await browser.storage.local.set({ enabled });
  await setModeStatus();
  return enabled;
}

async function initialize() {
  const stored = await browser.storage.local.get("enabled");
  if (typeof stored.enabled !== "boolean") {
    enabled = true;
    await browser.storage.local.set({ enabled: true });
  } else {
    enabled = stored.enabled === true;
  }
  await setModeStatus();
  addLog("info", `Firefox extension initialized. Mode: ${enabled ? "ON" : "OFF"}`);
}

initialize();

browser.runtime.onInstalled.addListener(async () => {
  enabled = true;
  await browser.storage.local.set({ enabled: true });
  await setModeStatus();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getState") {
    browser.storage.local.get([
      "enabled",
      "lastError",
      "lastPatchedUrl",
      "lastRunAt"
    ]).then((data) => {
      sendResponse({
        enabled: data.enabled ?? enabled,
        recentLogs: logsHistory,
        lastError: data.lastError || null,
        lastPatchedUrl: data.lastPatchedUrl || null,
        lastRunAt: data.lastRunAt || null
      });
    });
    return true;
  }

  if (message.action === "setEnabled") {
    setEnabledMode(message.enabled).then((newEnabled) => {
      sendResponse({ enabled: newEnabled, success: true });
    }).catch((err) => {
      sendResponse({ enabled, success: false, error: errorMessage(err) });
    });
    return true;
  }

  if (message.action === "openFlow") {
    browser.tabs.query({ active: true, currentWindow: true }).then(async ([activeTab]) => {
      if (!enabled) {
        enabled = true;
        await browser.storage.local.set({ enabled: true });
        await setModeStatus();
      }
      const targetTab = await chooseFlowTab(activeTab);
      sendResponse({ success: true, tabId: targetTab?.id });
    }).catch((err) => {
      sendResponse({ success: false, error: errorMessage(err) });
    });
    return true;
  }
});
