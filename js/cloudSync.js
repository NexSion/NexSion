const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDHo8ibB67IKZkwCf4zrFCINn4lZDzhV_8",
    projectId: "nexsion-4f4e0"
  },
  IDENTITY_TOOLKIT_URL = "https://identitytoolkit.googleapis.com/v1/accounts",
  SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token",
  FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
let cachedSession = null,
  pushTimer = null;
async function loadSession() {
  if (cachedSession) return cachedSession;
  const {
    cs_session: e
  } = await chrome.storage.local.get("cs_session");
  return cachedSession = e || null, cachedSession
}
async function saveSession(e) {
  cachedSession = e, await chrome.storage.local.set({
    cs_session: e
  })
}
async function clearSession() {
  cachedSession = null, await chrome.storage.local.remove("cs_session")
}
async function signInWithGoogleToken(e) {
  const o = await fetch(`${IDENTITY_TOOLKIT_URL}:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        postBody: `access_token=${e}&providerId=google.com`,
        requestUri: "https://nexsion.extension",
        returnSecureToken: !0
      })
    }),
    t = await o.json();
  if (!o.ok) throw new Error(t.error?.message || "Firebase sign-in failed");
  const a = {
    uid: t.localId,
    idToken: t.idToken,
    refreshToken: t.refreshToken,
    expiresAt: Date.now() + 1e3 * Number(t.expiresIn) - 6e4
  };
  return await saveSession(a), a
}
async function refreshSession(e) {
  const o = await fetch(`${SECURE_TOKEN_URL}?key=${FIREBASE_CONFIG.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `grant_type=refresh_token&refresh_token=${e.refreshToken}`
    }),
    t = await o.json();
  if (!o.ok) throw new Error(t.error?.message || "Cloud session refresh failed");
  const a = {
    uid: t.user_id,
    idToken: t.id_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + 1e3 * Number(t.expires_in) - 6e4
  };
  return await saveSession(a), a
}
async function getActiveSession() {
  let e = await loadSession();
  if (!e) return null;
  if (Date.now() >= e.expiresAt) try {
    e = await refreshSession(e)
  } catch (e) {
    return console.warn(
        "[NexSion] Cloud session expired and couldn't refresh — sign in again to resync.", e),
      await clearSession(), null
  }
  return e
}
async function getLocalUpdatedAt() {
  const {
    cs_local_updated_at: e
  } = await chrome.storage.local.get("cs_local_updated_at");
  return e || 0
}
async function setLocalUpdatedAt(e) {
  await chrome.storage.local.set({
    cs_local_updated_at: e
  })
}
async function fetchFullBackup() {
  const [e, o] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(
    null)]);
  return delete o.cs_session, delete o.cs_local_updated_at, delete o.lb_user, {
    sync: e,
    local: o
  }
}

// Bug fix (multi-device conflicts): individually addressable records — boards,
// items, pages — live under these key prefixes (see storage.js). Only these are
// safe to tombstone-delete on pull; settings/wallpaper blobs are single keys and
// are left to the existing last-write-wins merge below.
const RECORD_KEY_PREFIXES = ["sb:", "si:", "sp:"];

function isRecordKey(key) {
  const bare = key.startsWith("ovf_") ? key.slice(4) : key;
  return RECORD_KEY_PREFIXES.some(p => bare.startsWith(p));
}

// A record missing from the incoming snapshot is only a genuine delete if it
// already existed by the time that snapshot was taken. A record created on THIS
// device after the snapshot's timestamp just hasn't been pushed yet — removing
// it here would silently destroy something the user is about to see synced away.
function wasDeletedElsewhere(record, snapshotUpdatedAt) {
  const createdAt = record && typeof record.createdAt === "number" ? record.createdAt : 0;
  return createdAt <= snapshotUpdatedAt;
}

// Reconciles local storage.{sync,local} against an incoming cloud snapshot: any
// record present locally, absent from the snapshot, and old enough to have been
// part of that snapshot's world is removed — this is what makes a delete on one
// device actually stick on another, instead of chrome.storage.set()'s
// merge-only-add-keys behaviour silently resurrecting it.
async function reconcileDeletes(incomingSync, incomingLocal, snapshotUpdatedAt) {
  const [currentSync, currentLocal] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  const incomingSyncKeys = new Set(Object.keys(incomingSync || {}));
  const incomingLocalKeys = new Set(Object.keys(incomingLocal || {}));

  const staleSyncKeys = Object.keys(currentSync).filter(
    key => isRecordKey(key) && !incomingSyncKeys.has(key) &&
      wasDeletedElsewhere(currentSync[key], snapshotUpdatedAt)
  );
  const staleLocalKeys = Object.keys(currentLocal).filter(
    key => isRecordKey(key) && !incomingLocalKeys.has(key) &&
      wasDeletedElsewhere(currentLocal[key], snapshotUpdatedAt)
  );

  if (staleSyncKeys.length) await chrome.storage.sync.remove(staleSyncKeys).catch(() => {});
  if (staleLocalKeys.length) await chrome.storage.local.remove(staleLocalKeys).catch(() => {});
  if (staleSyncKeys.length || staleLocalKeys.length) {
    console.log(
      `[NexSion] Cloud sync: removed ${staleSyncKeys.length + staleLocalKeys.length} ` +
      "record(s) deleted on another device."
    );
  }
}

async function pushToCloud() {
  const session = await getActiveSession();
  if (!session) return;

  // Bug fix: merge in the latest cloud state (including deletions from other
  // devices) BEFORE building the snapshot we're about to push. Without this,
  // Device B pushing its own stale full snapshot is exactly what resurrects
  // something Device A already deleted.
  await pullFromCloud().catch(e => console.warn("[NexSion] Pre-push pull failed:", e));

  const backup = await fetchFullBackup(),
    now = Date.now(),
    body = {
      fields: {
        data: {
          stringValue: JSON.stringify(backup)
        },
        updatedAt: {
          integerValue: String(now)
        }
      }
    },
    res = await fetch(`${FIRESTORE_BASE}/nexsion_backups/${session.uid}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  res.ok ? await setLocalUpdatedAt(now) : console.warn("[NexSion] Cloud push failed:", await res
    .text().catch(() => ""))
}
async function pullFromCloud({
  force: force = !1
} = {}) {
  const session = await getActiveSession();
  if (!session) return {
    applied: !1,
    hadDoc: !1
  };
  const res = await fetch(`${FIRESTORE_BASE}/nexsion_backups/${session.uid}`, {
    headers: {
      Authorization: `Bearer ${session.idToken}`
    }
  });
  if (404 === res.status) return {
    applied: !1,
    hadDoc: !1
  };
  if (!res.ok) return console.warn("[NexSion] Cloud pull failed:", await res.text().catch(() =>
  "")), {
    applied: !1,
    hadDoc: !0
  };
  const doc = await res.json(),
    dataStr = doc.fields?.data?.stringValue;
  if (!dataStr) return {
    applied: !1,
    hadDoc: !0
  };
  const cloudUpdatedAt = Number(doc.fields?.updatedAt?.integerValue || 0),
    localUpdatedAt = await getLocalUpdatedAt();
  if (!force && cloudUpdatedAt <= localUpdatedAt) return console.log(
    "[NexSion] Skipped cloud pull — local data is already newer or equal."), {
    applied: !1,
    hadDoc: !0
  };
  const incoming = JSON.parse(dataStr);
  delete incoming.local?.lb_user;

  // Bug fix: remove local records that are missing from the incoming snapshot
  // (see reconcileDeletes) BEFORE merging the snapshot in. chrome.storage.set()
  // only adds/overwrites keys — it never removes ones absent from the object —
  // so without this step a delete could reach the cloud but never actually
  // apply on the other device.
  await reconcileDeletes(incoming.sync, incoming.local, cloudUpdatedAt);

  return await Promise.all([
    chrome.storage.sync.set(incoming.sync || {}),
    chrome.storage.local.set(incoming.local || {})
  ]), await setLocalUpdatedAt(cloudUpdatedAt), {
    applied: !0,
    hadDoc: !0
  }
}

function scheduleSync() {
  setLocalUpdatedAt(Date.now()).catch(() => {}), clearTimeout(pushTimer), pushTimer = setTimeout(
  () => {
      pushToCloud().catch(e => console.warn("[NexSion] Cloud sync error:", e))
    }, 2e3)
}
async function flushPendingSync() {
  pushTimer && (clearTimeout(pushTimer), pushTimer = null, await pushToCloud().catch(e => console
    .warn("[NexSion] Cloud sync flush error:", e)))
}
const CloudSync = {
  async signIn(e) {
    await signInWithGoogleToken(e);
    try {
      await self.Store.clearBoardData()
    } catch (e) {
      console.warn("[NexSion] Couldn't clear local data before sign-in:", e)
    }
    const {
      applied: o,
      hadDoc: t
    } = await pullFromCloud({
      force: !0
    });
    return o || await pushToCloud(), {
      isNewAccount: !t
    }
  },
  async signOut() {
    clearTimeout(pushTimer), pushTimer = null, await clearSession()
  },
  async deleteAccount() {
    const e = await getActiveSession();
    e && (await fetch(`${FIRESTORE_BASE}/nexsion_backups/${e.uid}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${e.idToken}`
      }
    }).catch(() => {}), await fetch(
      `${IDENTITY_TOOLKIT_URL}:delete?key=${FIREBASE_CONFIG.apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idToken: e.idToken
        })
      }).catch(() => {}), clearTimeout(pushTimer), pushTimer = null, await clearSession())
  },
  notifyChange: scheduleSync,
  flushPendingSync: flushPendingSync,
  isSignedIn: async () => !!await loadSession(),
  pullLatest: pullFromCloud,
  async forcePushToCloud() {
    if (!await getActiveSession()) throw new Error("Not signed in");
    await pushToCloud()
  },
  async forcePullFromCloud() {
    if (!await getActiveSession()) throw new Error("Not signed in");
    const {
      hadDoc: e
    } = await pullFromCloud({
      force: !0
    });
    if (!e) throw new Error("No cloud backup found for this account yet")
  },
  createShareLink: createShareLink
};
// Real shareable links (as opposed to a paste-in code). Requires a Firestore
// security rule on the "nexsion_shares" collection:
//   match /nexsion_shares/{shareId} {
//     allow read: if true;                 // anyone can open a shared link
//     allow create: if request.auth != null; // only signed-in users can publish one
//     allow update, delete: if false;
//   }
// Without that rule this call will fail with a permission-denied response —
// presentShareModal() in app.js already falls back to the text code either way.
function generateShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

async function createShareLink(payload, title) {
  const session = await getActiveSession();
  if (!session) throw new Error("Sign in to create a shareable link");

  const shareId = generateShareId(),
    body = {
      fields: {
        title: { stringValue: title || "" },
        data: { stringValue: JSON.stringify(payload) },
        createdAt: { integerValue: String(Date.now()) },
      },
    },
    res = await fetch(
      `${FIRESTORE_BASE}/nexsion_shares?documentId=${shareId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      errText.includes("PERMISSION_DENIED")
        ? "Shareable links aren't enabled yet for this project (Firestore rule missing)."
        : "Couldn't create the share link — try again."
    );
  }
  return `https://nexsion.netlify.app/s/?id=${shareId}`;
}
