importScripts("patch.js");

const FLOW_HOME = "https://flow.google.com/";
const FLOW_HOST = "flow.google.com";
const FLOW_URL_PATTERN = /^https:\/\/flow\.google\.com\//;
const TARGET_HOST = "www.gstatic.com";
const TARGET_BUNDLE_MARKER = "AiSandboxAngularFrontend";
const TARGET_BUNDLE_SUFFIX = "/m=_b";
const CDP_VERSION = "1.3";
const INTERCEPT_TIMEOUT_MS = 25000;
const SUCCESS_BADGE_MS = 3000;
const UNSUPPORTED_REDIRECT_COOLDOWN_MS = 15000;

const sessions = new Map();
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

  const prefix = `[FlowUnlocker ${time}]`;
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
    const lang = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
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
      chrome.action.setBadgeBackgroundColor({ ...target, color: status.color }),
      chrome.action.setBadgeText({ ...target, text: status.text }),
      chrome.action.setTitle({ ...target, title })
    ]);
  } catch {
    // Ignore badge errors if tab closed
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

function decodeResponseBody(response) {
  if (!response.base64Encoded) {
    return response.body;
  }

  const binary = atob(response.body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 0x2000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return {
    body: btoa(binary),
    byteLength: bytes.byteLength
  };
}

function buildResponseHeaders(headers, byteLength) {
  const replacedHeaders = new Set([
    "age",
    "cache-control",
    "content-encoding",
    "content-length",
    "content-md5",
    "etag",
    "transfer-encoding"
  ]);

  const result = (headers || []).filter(
    (header) => !replacedHeaders.has(header.name.toLowerCase())
  );
  result.push({ name: "Cache-Control", value: "no-store, no-cache, must-revalidate" });
  result.push({ name: "Pragma", value: "no-cache" });
  result.push({ name: "Content-Length", value: String(byteLength) });
  return result;
}

async function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function detach(tabId, finalStatus, detail) {
  addLog("info", `Detaching debugger from tab ${tabId}. Final status: ${finalStatus}`);
  const session = sessions.get(tabId);
  if (session?.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  sessions.delete(tabId);

  try {
    await send(tabId, "Fetch.disable");
  } catch {
    // Ignore
  }

  try {
    await send(tabId, "Network.setCacheDisabled", { cacheDisabled: false });
  } catch {
    // Ignore
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Ignore
  }

  try {
    await setStatus(tabId, finalStatus, detail);
  } catch {
    // Ignore
  }

  if (finalStatus === "OK" && enabled) {
    setTimeout(() => {
      if (enabled && !sessions.has(tabId)) {
        void setStatus(tabId, "ON");
      }
    }, SUCCESS_BADGE_MS);
  }
}

async function failSession(tabId, detail) {
  addLog("error", `Session failed on tab ${tabId}: ${detail}`);
  try {
    await chrome.storage.local.set({
      lastError: detail,
      lastRunAt: new Date().toISOString()
    });
  } catch {
    // Ignore
  }
  await detach(tabId, "ERR", detail);
}

async function completeSession(tabId, url) {
  const session = sessions.get(tabId);
  const shouldReturnHome = session?.returnHome === true;
  const redirectWasSuppressed = session?.redirectSuppressed === true;

  if (redirectWasSuppressed) {
    addLog("warn", `Repeated unsupported-country redirect was stopped on tab ${tabId}`);
  } else {
    addLog("info", `Session completed successfully on tab ${tabId} for bundle ${url}`);
  }

  try {
    await chrome.storage.local.set({
      lastError: redirectWasSuppressed ? "Repeated unsupported-country redirect was stopped." : null,
      lastPatchedUrl: url,
      lastRunAt: new Date().toISOString()
    });
  } catch {
    // Ignore
  }
  await detach(
    tabId,
    redirectWasSuppressed ? "ERR" : "OK",
    redirectWasSuppressed ? "Redirect stopped" : undefined
  );

  if (shouldReturnHome && enabled) {
    lastUnsupportedRedirectAt.set(tabId, Date.now());
    addLog("info", `Navigating tab ${tabId} to Flow home: ${FLOW_HOME}`);
    try {
      await chrome.tabs.update(tabId, { url: FLOW_HOME });
    } catch {
      // Ignore
    }
  }
}

async function continueOriginal(tabId, requestId) {
  try {
    await send(tabId, "Fetch.continueRequest", { requestId });
  } catch {
    // Ignore
  }
}

async function handlePausedResponse(source, params) {
  const tabId = source.tabId;
  const session = sessions.get(tabId);
  if (!session) {
    return;
  }

  const reqUrl = params.request?.url || "";

  if (!isTargetBundle(reqUrl)) {
    await continueOriginal(tabId, params.requestId);
    return;
  }

  if (session.handling) {
    addLog("warn", `Target bundle already being handled for tab ${tabId}, skipping duplicate.`);
    await continueOriginal(tabId, params.requestId);
    return;
  }
  session.handling = true;

  addLog("info", `🎯 TARGET BUNDLE DETECTED! URL: ${reqUrl}`);

  let fulfilled = false;
  try {
    if (!params.responseStatusCode || params.responseStatusCode < 200 || params.responseStatusCode >= 300) {
      throw new Error(`Unexpected bundle response status: ${params.responseStatusCode || "unknown"}`);
    }

    addLog("info", `Downloading response body via CDP...`);
    const response = await send(tabId, "Fetch.getResponseBody", { requestId: params.requestId });
    const sourceText = decodeResponseBody(response);
    addLog("info", `Bundle size: ${sourceText.length} chars. Applying FlowPatch...`);

    const patchResult = (globalThis.FlowPatch || globalThis.BezmezhauPatch).patchSource(sourceText);

    if (!patchResult.ok) {
      throw new Error(patchResult.error);
    }

    addLog("info", `Encoding patched bundle to base64...`);
    const encoded = encodeBase64(patchResult.source);

    addLog("info", `Fulfilling request with patched bundle...`);
    await send(tabId, "Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode,
      responsePhrase: params.responseStatusText || "OK",
      responseHeaders: buildResponseHeaders(params.responseHeaders, encoded.byteLength),
      body: encoded.body
    });
    fulfilled = true;
    addLog("info", `✅ Flow bundle successfully patched & delivered!`);
    await completeSession(tabId, params.request.url);
  } catch (error) {
    addLog("error", `Failed during bundle patching: ${errorMessage(error)}`);
    if (!fulfilled) {
      await continueOriginal(tabId, params.requestId);
    }
    await failSession(tabId, errorMessage(error));
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Fetch.requestPaused" && Number.isInteger(source.tabId)) {
    void handlePausedResponse(source, params);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isInteger(source.tabId)) return;

  const session = sessions.get(source.tabId);
  if (!session) return;

  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  sessions.delete(source.tabId);
  void setStatus(source.tabId, enabled ? "ERR" : "OFF", `Debugger detached: ${reason}`);
});

async function startSession(tabId, navigationUrl) {
  if (!enabled || !Number.isInteger(tabId) || sessions.has(tabId)) {
    return;
  }

  const targetUrl = (isFlowUrl(navigationUrl) && !isUnsupportedCountryUrl(navigationUrl))
    ? navigationUrl
    : FLOW_HOME;
  addLog("info", `Starting unlock session for tab ${tabId} -> targetUrl: ${targetUrl}`);
  await setStatus(tabId, "RUN");

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);

    const timeoutId = setTimeout(() => {
      if (sessions.has(tabId)) {
        addLog("error", `⏰ Timeout reached: target bundle was not intercepted within ${INTERCEPT_TIMEOUT_MS / 1000}s`);
        void failSession(tabId, "Target bundle was not intercepted within timeout.");
      }
    }, INTERCEPT_TIMEOUT_MS);

    sessions.set(tabId, {
      handling: false,
      timeoutId,
      returnHome: false,
      redirectSuppressed: false
    });

    try {
      await send(tabId, "Page.stopLoading");
    } catch {
      // Ignore
    }

    await send(tabId, "Page.enable");
    await send(tabId, "Network.enable");
    await send(tabId, "Network.setCacheDisabled", { cacheDisabled: true });

    const pattern = "https://www.gstatic.com/*AiSandboxAngularFrontend*/m=_b*";
    await send(tabId, "Fetch.enable", {
      patterns: [
        {
          urlPattern: pattern,
          resourceType: "Script",
          requestStage: "Response"
        }
      ]
    });

    await send(tabId, "Page.navigate", { url: targetUrl });
  } catch (error) {
    addLog("error", `Failed to start session on tab ${tabId}: ${errorMessage(error)}`);
    if (sessions.has(tabId)) {
      await failSession(tabId, errorMessage(error));
    } else {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Ignore
      }
      await chrome.storage.local.set({
        lastError: errorMessage(error),
        lastRunAt: new Date().toISOString()
      });
      await setStatus(tabId, "ERR", errorMessage(error));
    }
  }
}

async function chooseFlowTab(clickedTab) {
  if (Number.isInteger(clickedTab?.id) && isFlowUrl(clickedTab.url)) {
    return clickedTab;
  }

  const existingTabs = await chrome.tabs.query({ url: `${FLOW_HOME}*` });
  if (existingTabs.length > 0 && Number.isInteger(existingTabs[0].id)) {
    await chrome.tabs.update(existingTabs[0].id, { active: true });
    if (Number.isInteger(existingTabs[0].windowId)) {
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
    }
    return existingTabs[0];
  }

  return chrome.tabs.create({ active: true, url: "about:blank" });
}

async function stopAllSessions() {
  const tabIds = [...sessions.keys()];
  await Promise.all(
    tabIds.map((tabId) => detach(tabId, "OFF", "Disabled by user."))
  );
}

async function setEnabledMode(targetEnabled) {
  const stored = await chrome.storage.local.get("enabled");
  const current = stored.enabled === true;
  enabled = typeof targetEnabled === "boolean" ? targetEnabled : !current;
  await chrome.storage.local.set({ enabled });
  await setModeStatus();

  if (!enabled) {
    await stopAllSessions();
  }
  return enabled;
}

async function cleanupOrphanedDebuggers() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
      if (target.attached && target.tabId && !sessions.has(target.tabId)) {
        try {
          await chrome.debugger.detach({ tabId: target.tabId });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }
}

async function initializeEnabledState() {
  const stored = await chrome.storage.local.get("enabled");

  if (typeof stored.enabled !== "boolean") {
    enabled = true;
    await chrome.storage.local.set({ enabled: true });
  } else {
    enabled = stored.enabled === true;
  }

  await setModeStatus();
  await cleanupOrphanedDebuggers();
}

const enabledReady = initializeEnabledState();

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;

    const session = sessions.get(details.tabId);
    if (session) {
      if (isUnsupportedCountryUrl(details.url)) {
        if (redirectedRecently(details.tabId)) {
          session.redirectSuppressed = true;
        } else {
          session.returnHome = true;
        }
      }
      return;
    }

    void enabledReady.then(() => {
      if (!enabled) return;

      if (isUnsupportedCountryUrl(details.url) && redirectedRecently(details.tabId)) {
        return setStatus(details.tabId, "ERR", "Repeated redirect stopped.");
      }

      return startSession(
        details.tabId,
        isUnsupportedCountryUrl(details.url) ? FLOW_HOME : details.url
      );
    }).catch((error) => {
      addLog("error", `onBeforeNavigate error: ${errorMessage(error)}`);
    });
  },
  { url: [{ schemes: ["https"], hostEquals: FLOW_HOST }] }
);

function handleUnsupportedUrl(tabId, url) {
  if (!enabled || !Number.isInteger(tabId) || !isUnsupportedCountryUrl(url)) return;
  if (redirectedRecently(tabId)) return;

  lastUnsupportedRedirectAt.set(tabId, Date.now());
  addLog("warn", `Detected /unsupported-country on tab ${tabId}. Redirecting to Flow Home...`);
  chrome.tabs.update(tabId, { url: FLOW_HOME }).catch(() => {});
}

chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId === 0) {
      handleUnsupportedUrl(details.tabId, details.url);
    }
  },
  { url: [{ schemes: ["https"], hostEquals: FLOW_HOST }] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && isUnsupportedCountryUrl(changeInfo.url)) {
    handleUnsupportedUrl(tabId, changeInfo.url);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  enabled = true;
  await chrome.storage.local.set({ enabled: true });
  await setModeStatus();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getState") {
    chrome.storage.local.get([
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
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([activeTab]) => {
      if (!enabled) {
        enabled = true;
        await chrome.storage.local.set({ enabled: true });
        await setModeStatus();
      }
      const targetTab = await chooseFlowTab(activeTab);
      if (Number.isInteger(targetTab.id)) {
        await startSession(
          targetTab.id,
          isFlowUrl(targetTab.url) ? targetTab.url : FLOW_HOME
        );
      }
      sendResponse({ success: true, tabId: targetTab?.id });
    }).catch((err) => {
      sendResponse({ success: false, error: errorMessage(err) });
    });
    return true;
  }
});
