document.addEventListener("DOMContentLoaded", async () => {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  // UI Elements
  const modeToggle = document.getElementById("modeToggle");
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const openFlowBtn = document.getElementById("openFlowBtn");
  const openFlowBtnText = document.getElementById("openFlowBtnText");
  const patcherState = document.getElementById("patcherState");
  const lastRunTime = document.getElementById("lastRunTime");
  const dohUrlInput = document.getElementById("dohUrlInput");
  const copyDohBtn = document.getElementById("copyDohBtn");
  const copyLogsBtn = document.getElementById("copyLogsBtn");
  const logsConsole = document.getElementById("logsConsole");
  const navTabs = document.querySelectorAll(".nav-tab");
  const tabContents = document.querySelectorAll(".tab-content");

  // Tab Switching
  navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTabId = tab.getAttribute("data-tab");
      navTabs.forEach((t) => t.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const targetContent = document.getElementById(targetTabId);
      if (targetContent) targetContent.classList.add("active");
    });
  });

  // Copy DoH URL
  if (copyDohBtn && dohUrlInput) {
    copyDohBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(dohUrlInput.value);
        const originalHtml = copyDohBtn.innerHTML;
        copyDohBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        setTimeout(() => {
          copyDohBtn.innerHTML = originalHtml;
        }, 1500);
      } catch (err) {
        console.error("Clipboard copy failed:", err);
      }
    });
  }

  // Update Status Display
  function updateStatusDisplay(enabled, isRunning = false, isError = false) {
    statusBadge.className = "status-badge";
    if (isError) {
      statusBadge.classList.add("status-err");
      statusText.textContent = "ОШБ";
      patcherState.textContent = "Ошибка при патчинге";
      patcherState.className = "info-value text-error";
    } else if (isRunning) {
      statusBadge.classList.add("status-run");
      statusText.textContent = "РАБ";
      patcherState.textContent = "Снятие ограничений...";
      patcherState.className = "info-value text-warn";
    } else if (enabled) {
      statusBadge.classList.add("status-on");
      statusText.textContent = "ВКЛ";
      patcherState.textContent = "Активен (готов к Flow)";
      patcherState.className = "info-value text-success";
    } else {
      statusBadge.classList.add("status-off");
      statusText.textContent = "ВЫКЛ";
      patcherState.textContent = "Отключен пользователем";
      patcherState.className = "info-value text-muted";
    }
  }

  // Render Logs
  function renderLogs(logs) {
    if (!logsConsole) return;
    if (!Array.isArray(logs) || logs.length === 0) {
      logsConsole.innerHTML = '<div class="log-entry log-info">[Flow Unlocker] Ожидание активности...</div>';
      return;
    }

    logsConsole.innerHTML = "";
    logs.slice(-30).forEach((entry) => {
      const line = document.createElement("div");
      line.className = `log-entry log-${entry.level || "info"}`;
      line.textContent = `[${entry.time}] ${entry.message}`;
      logsConsole.appendChild(line);
    });

    logsConsole.scrollTop = logsConsole.scrollHeight;
  }

  // Copy Logs
  if (copyLogsBtn) {
    copyLogsBtn.addEventListener("click", async () => {
      try {
        const text = logsConsole.innerText || "";
        await navigator.clipboard.writeText(text);
        const originalText = copyLogsBtn.textContent;
        copyLogsBtn.textContent = "Скопировано!";
        setTimeout(() => {
          copyLogsBtn.textContent = originalText;
        }, 1500);
      } catch (err) {
        console.error("Failed to copy logs:", err);
      }
    });
  }

  // Fetch Full State from Background
  async function refreshState() {
    try {
      const response = await new Promise((resolve) => {
        ext.runtime.sendMessage({ action: "getState" }, (res) => {
          resolve(res);
        });
      });

      if (response) {
        const isEnabled = response.enabled === true;
        modeToggle.checked = isEnabled;
        updateStatusDisplay(isEnabled, false, Boolean(response.lastError));

        if (response.lastRunAt) {
          const d = new Date(response.lastRunAt);
          lastRunTime.textContent = d.toLocaleTimeString();
        }

        if (response.recentLogs) {
          renderLogs(response.recentLogs);
        }
      }
    } catch (err) {
      console.warn("Could not query background state:", err);
    }
  }

  // Initial Load
  await refreshState();

  // Mode Toggle Switch
  modeToggle.addEventListener("change", async () => {
    const targetState = modeToggle.checked;
    updateStatusDisplay(targetState);

    try {
      await new Promise((resolve) => {
        ext.runtime.sendMessage({ action: "setEnabled", enabled: targetState }, resolve);
      });
    } catch {
      await ext.storage.local.set({ enabled: targetState });
    }
    await refreshState();
  });

  // Open Google Flow Button
  openFlowBtn.addEventListener("click", async () => {
    openFlowBtn.disabled = true;
    const originalText = openFlowBtnText.textContent;
    openFlowBtnText.textContent = "Открытие...";
    updateStatusDisplay(true, true);

    try {
      await new Promise((resolve) => {
        ext.runtime.sendMessage({ action: "openFlow" }, resolve);
      });
    } catch {
      if (ext.tabs && ext.tabs.create) {
        await ext.tabs.create({ url: "https://flow.google.com/" });
      } else {
        window.open("https://flow.google.com/", "_blank");
      }
    }

    setTimeout(() => {
      openFlowBtn.disabled = false;
      openFlowBtnText.textContent = originalText;
      window.close();
    }, 800);
  });

  // Real-time Storage Listener
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.enabled) {
      modeToggle.checked = changes.enabled.newValue === true;
      updateStatusDisplay(modeToggle.checked);
    }
    if (changes.lastRunAt && changes.lastRunAt.newValue) {
      const d = new Date(changes.lastRunAt.newValue);
      lastRunTime.textContent = d.toLocaleTimeString();
    }
    if (changes.lastError) {
      updateStatusDisplay(modeToggle.checked, false, Boolean(changes.lastError.newValue));
    }
  });
});
