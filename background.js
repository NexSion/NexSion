async function quickSaveActiveTab() {
  const [e] = await chrome.tabs.query({
    active: !0,
    currentWindow: !0
  });
  if (!e || !e.url || e.url.startsWith("chrome://")) return void notify("Can't save this page",
    "This tab can't be saved to NexSion.");
  const t = await Store.getSettings(),
    n = await Store.getBoards(),
    i = n.find(e => e.id === (t.quickSaveBoardId || "board-quick")) || n[0];
  i ? (await Store.addItem({
    boardId: i.id,
    title: e.title,
    url: e.url,
    favicon: e.favIconUrl || ""
  }), notify("Saved to NexSion", `${e.title||e.url} → ${i.name}`)) : notify(
    "No board available", "Create a board in NexSion first.")
}

function notify(e, t) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: e,
    message: t
  })
}
const CTX_PARENT_ID = "nexsion-save-parent";
async function rebuildContextMenu() {
  await new Promise(e => chrome.contextMenus.removeAll(e)), chrome.contextMenus.create({
    id: CTX_PARENT_ID,
    title: "Save to NexSion",
    contexts: ["page", "link"]
  });
  let e = [];
  try {
    e = await Store.getBoards()
  } catch (e) {
    console.warn("[NexSion] Couldn't load boards for context menu:", e)
  }
  if (!e.length) return void chrome.contextMenus.create({
    id: "nexsion-save-noboards",
    parentId: CTX_PARENT_ID,
    title: "No boards yet — open NexSion first",
    enabled: !1
  });
  const t = {};
  try {
    (await Store.getPages()).forEach(e => t[e.id] = e.name)
  } catch {}
  e.forEach(e => {
    const n = t[e.pageId] ? ` (${t[e.pageId]})` : "";
    chrome.contextMenus.create({
      id: "nexsion-save-board:" + e.id,
      parentId: CTX_PARENT_ID,
      title: e.name + n
    })
  })
}
chrome.contextMenus.onClicked.addListener(async (e, t) => {
  if (!e.menuItemId.startsWith("nexsion-save-board:")) return;
  const n = e.menuItemId.slice(19),
    i = e.linkUrl || e.pageUrl || t?.url,
    o = e.linkUrl ? e.selectionText || e.linkUrl : t?.title || i;
  if (!i) return;
  const a = (await Store.getBoards()).find(e => e.id === n);
  a ? (await Store.addItem({
    boardId: n,
    title: o,
    url: i,
    favicon: t?.favIconUrl || ""
  }), notify("Saved to NexSion", `${o} → ${a.name}`)) : notify("Couldn't save",
    "That board no longer exists — reopen the menu to refresh the list.")
}), importScripts("js/storage.js", "js/cloudSync.js", "js/updater.js");

/* ---------------- Background auto-update ----------------
 * Runs independently of whether any NexSion tab is open, so every user
 * eventually finds out about a new release — via a system notification if
 * nothing else, or via a fully silent install if they've turned Auto-Update
 * on and already linked (and granted write permission to) their update
 * folder. Progress is broadcast as runtime messages so any open NexSion
 * page can show a corner toast; nothing breaks if no page is listening.
 * ----------------------------------------------------------------------- */
const UPDATE_CHECK_ALARM = "nexsion-update-check";
const UPDATE_NOTIFICATION_ID = "nexsion-update-available";
const UPDATE_CHECK_PERIOD_MINUTES = 180; // every 3 hours

function scheduleUpdateChecks() {
  chrome.alarms.create(UPDATE_CHECK_ALARM, {
    periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES,
    delayInMinutes: 1
  });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function runBackgroundUpdateCheck() {
  let result;
  try {
    result = await NexSionUpdater.checkForUpdate();
  } catch (e) {
    console.warn("[NexSion] Background update check failed:", e);
    return;
  }

  await chrome.storage.local.set({
    nexsion_update_state: {
      current: result.current,
      latest: result.latest,
      available: result.available,
      zipUrl: result.zipUrl,
      notes: result.notes,
      checkedAt: Date.now()
    }
  });
  broadcast({
    type: "nexsion-update-state-changed",
    state: result
  });

  if (!result.available) return;

  const {
    nexsion_last_notified_version: lastNotified
  } = await chrome.storage.local.get("nexsion_last_notified_version");
  if (lastNotified === result.latest) return; // already handled this version once

  let settings = {};
  try {
    settings = await Store.getSettings();
  } catch {}

  const canInstallSilently = settings.autoUpdate && await NexSionUpdater.hasSilentWritePermission();

  if (canInstallSilently) {
    await attemptSilentAutoUpdate(result);
  } else {
    notifyUpdateAvailable(result);
  }

  await chrome.storage.local.set({
    nexsion_last_notified_version: result.latest
  });
}

function notifyUpdateAvailable(result) {
  chrome.notifications.create(UPDATE_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NexSion update available",
    message: `v${result.latest} is ready — click to view what's new and install in one click.`,
    buttons: [{
      title: "View & Install"
    }],
    priority: 2
  });
}

async function attemptSilentAutoUpdate(result) {
  broadcast({
    type: "nexsion-update-progress",
    stage: "Downloading update…"
  });
  try {
    await NexSionUpdater.installUpdate(result.zipUrl, stage => {
      broadcast({
        type: "nexsion-update-progress",
        stage
      });
    });
    // installUpdate() hands off to finishUpdateAndReload() below, which calls
    // chrome.runtime.reload() — this service worker instance ends there.
  } catch (e) {
    console.warn("[NexSion] Silent auto-update failed:", e);
    broadcast({
      type: "nexsion-update-progress",
      stage: null
    });
    chrome.notifications.create("nexsion-auto-update-failed", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "NexSion couldn't auto-update",
      message: `Couldn't install v${result.latest} automatically (${e.message||"unknown error"}). Click to install it yourself — one click, no re-download.`,
      priority: 2
    });
    // Still surface the normal "view & install" path so the user has a 1-click fallback.
    notifyUpdateAvailable(result);
  }
}

/** Opens (or focuses) a NexSion tab and tells it to jump straight to Settings → Updates. */
async function openUpdatesTab() {
  const extNewtabUrl = chrome.runtime.getURL("newtab.html");
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find(t => t.url === "chrome://newtab/" || t.url && t.url.startsWith(
      extNewtabUrl));
    if (existing) {
      await chrome.windows.update(existing.windowId, {
        focused: true
      });
      await chrome.tabs.update(existing.id, {
        active: true
      });
      chrome.tabs.sendMessage(existing.id, {
        type: "nexsion-open-updates"
      }).catch(() => {});
      return;
    }
  } catch (e) {
    console.warn("[NexSion] Couldn't look for an open NexSion tab:", e);
  }
  try {
    await chrome.tabs.create({
      url: extNewtabUrl + "?open=updates"
    });
  } catch (e) {
    console.warn("[NexSion] Couldn't open a NexSion tab:", e);
  }
}

chrome.notifications.onClicked.addListener(id => {
  if (id !== UPDATE_NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  openUpdatesTab();
});
chrome.notifications.onButtonClicked.addListener(id => {
  if (id !== UPDATE_NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  openUpdatesTab();
});

/**
 * Runs after installUpdate() has written the new files to disk. Finds every
 * open NexSion tab (not just "the active tab" — that was the old bug, which
 * could swap an unrelated tab if the click didn't happen from NexSion itself,
 * and simply couldn't work at all for a background-triggered auto-update
 * since there is no "active tab" to speak of), remembers them, then reloads
 * the extension. Reloading tears down this service worker immediately, so
 * the actual tab swap happens in handlePendingPostUpdateSwap() below, which
 * runs again as soon as the freshly-updated background.js starts back up.
 */
async function finishUpdateAndReload() {
  const extNewtabUrl = chrome.runtime.getURL("newtab.html");
  let idsToSwap = [];
  try {
    const tabs = await chrome.tabs.query({});
    idsToSwap = tabs
      .filter(t => t.url === "chrome://newtab/" || t.url && t.url.startsWith(extNewtabUrl))
      .map(t => t.id);
  } catch (e) {
    console.warn("[NexSion] Couldn't enumerate NexSion tabs before reload:", e);
  }
  await chrome.storage.local.set({
    nexsion_pending_tab_swap_ids: idsToSwap
  });
  chrome.runtime.reload();
}

function setupYoutubeReferrerRule() {
  if (!chrome.declarativeNetRequest) return void console.warn(
    "[NexSion] declarativeNetRequest API not available — the extension needs a full reload (remove + Load unpacked again) to pick up the new manifest permission."
    );
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      condition: {
        initiatorDomains: [chrome.runtime.id],
        requestDomains: ["www.youtube.com", "youtube.com"],
        resourceTypes: ["sub_frame"]
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{
          header: "referer",
          operation: "set",
          value: "https://www.youtube.com/"
        }]
      }
    }]
  }).catch(e => console.warn("[NexSion] Couldn't set YouTube referer rule:", e))
}
chrome.runtime.onInstalled.addListener(() => {
  Store.ensureSeeded(), rebuildContextMenu(), scheduleUpdateChecks()
}), chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu(), scheduleUpdateChecks()
}), chrome.commands.onCommand.addListener(e => {
  "quick-save" === e && quickSaveActiveTab()
}), chrome.runtime.onMessage.addListener((e, t, n) => {
  if ("quick-save" === e?.type) return quickSaveActiveTab().then(() => n({
    ok: !0
  })), !0;
  if ("nexsion-finish-update" === e?.type) return finishUpdateAndReload().then(() => n({
    ok: !0
  })), !0;
  if ("nexsion-check-for-update" === e?.type) return runBackgroundUpdateCheck().then(() => n({
    ok: !0
  })), !0;
  "boards-changed" !== e?.type || rebuildContextMenu()
}), chrome.alarms.onAlarm.addListener(async e => {
  if (e.name === UPDATE_CHECK_ALARM) return void runBackgroundUpdateCheck();
  if (!e.name.startsWith("remind:")) return;
  const t = e.name.slice(7),
    n = (await Store.getAllItems()).find(e => e.id === t);
  n && (chrome.notifications.create(e.name, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "⏰ " + (n.title || n.url),
    message: n.url || ""
  }), await Store.updateItem(t, {
    remindAt: null
  }))
}), chrome.notifications.onClicked.addListener(e => {
  if (!e.startsWith("remind:")) return;
  const t = e.slice(7);
  Store.getAllItems().then(e => {
    const n = e.find(e => e.id === t);
    n?.url && chrome.tabs.create({
      url: n.url
    })
  }), chrome.notifications.clear(e)
});

/* ---------------- Website <-> extension session bridge ----------------
 * Only reachable from origins listed in manifest.json's
 * "externally_connectable" (the NexSion website). Lets the website:
 *   - ask whether this browser already has a signed-in NexSion session
 *     ("nexsion-get-auth-state"), so the site can mirror that state
 *     instantly instead of asking the person to sign in twice;
 *   - push a session it just created via its own Google sign-in
 *     ("nexsion-adopt-session"), so signing in on the website also signs
 *     the extension in, automatically, with no extra click here;
 *   - tell the extension the website signed out ("nexsion-sign-out").
 * All three respond asynchronously, hence `return !0` to keep the message
 * channel open — see MDN's chrome.runtime.onMessage docs on returning true.
 * ----------------------------------------------------------------------- */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "nexsion-get-auth-state") {
    Store.getUser().then(user => {
      sendResponse({
        signedIn: !!user,
        user: user || null
      });
    }).catch(() => sendResponse({
      signedIn: !1,
      user: null
    }));
    return !0;
  }

  if (message.type === "nexsion-adopt-session") {
    CloudSync.adoptExternalSession(message.session, message.profile).then(() => {
      sendResponse({
        ok: !0
      });
      broadcast({
        type: "boards-changed"
      });
    }).catch(e => {
      console.warn("[NexSion] Couldn't adopt session pushed from website:", e);
      sendResponse({
        ok: !1,
        error: e.message
      });
    });
    return !0;
  }

  if (message.type === "nexsion-sign-out") {
    CloudSync.signOutExternal().then(() => sendResponse({
      ok: !0
    })).catch(e => sendResponse({
      ok: !1,
      error: e.message
    }));
    return !0;
  }
});

async function handlePendingPostUpdateSwap() {
  const {
    nexsion_pending_tab_swap_ids: ids
  } = await chrome.storage.local.get("nexsion_pending_tab_swap_ids");
  if (!ids || !ids.length) return;
  await chrome.storage.local.remove("nexsion_pending_tab_swap_ids");
  for (const id of ids) {
    try {
      await chrome.tabs.create({})
    } catch (e) {
      console.warn("[NexSion] Couldn't open a fresh tab after update:", e)
    }
    try {
      await chrome.tabs.remove(id)
    } catch (e) {
      console.warn("[NexSion] Couldn't close a pre-update tab:", e)
    }
  }
}
handlePendingPostUpdateSwap();
