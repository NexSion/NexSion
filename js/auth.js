const WEB_CLIENT_ID = self.NEXSION_CONFIG.WEB_CLIENT_ID,
  OAUTH_SCOPES = self.NEXSION_CONFIG.OAUTH_SCOPES;
async function getGoogleTokenWithPicker() {
  const e = chrome.identity.getRedirectURL(),
    t =
    `https://accounts.google.com/o/oauth2/auth?client_id=${encodeURIComponent(WEB_CLIENT_ID)}&response_type=token&redirect_uri=${encodeURIComponent(e)}&scope=${encodeURIComponent(OAUTH_SCOPES)}&prompt=select_account`,
    o = await new Promise((e, o) => {
      chrome.identity.launchWebAuthFlow({
        url: t,
        interactive: !0
      }, t => {
        !chrome.runtime.lastError && t ? e(t) : o(chrome.runtime.lastError || new Error(
          "Sign-in was cancelled"))
      })
    }),
    n = new URLSearchParams(o.split("#")[1] || "").get("access_token");
  if (!n) throw new Error("No access token returned from sign-in");
  return n
}
const Auth = {
  async signIn() {
    const e = await getGoogleTokenWithPicker(),
      t = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: {
          Authorization: `Bearer ${e}`
        }
      });
    if (!t.ok) throw new Error("Failed to fetch Google profile");
    const o = await t.json(),
      n = {
        name: o.name || o.email,
        email: o.email,
        picture: o.picture || ""
      };
    let i = !1;
    try {
      const t = await CloudSync.signIn(e);
      i = !!t?.isNewAccount
    } catch (e) {
      console.warn(
        "[NexSion] Cloud sync sign-in failed — you're signed in, but this device won't auto-sync:",
        e)
    }
    return await Store.setUser(n), {
      ...n,
      isNewAccount: i
    }
  },
  async signOut() {
    // Cross-browser fix: chrome.identity.getAuthToken is Chrome-only and is not
    // implemented in Microsoft Edge. Since sign-in uses launchWebAuthFlow (which
    // works in both), clear the cached flow token instead of calling getAuthToken.
    try {
      if (chrome.identity.clearAllCachedAuthTokens) {
        await new Promise(resolve => chrome.identity.clearAllCachedAuthTokens(resolve));
      }
    } catch {}
    await CloudSync.signOut(), await Store.setUser(null)
  },
  async deleteAccount() {
    await CloudSync.deleteAccount(), await Store.setUser(null)
  }
};
self.Auth = Auth;
