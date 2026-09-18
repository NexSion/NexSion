/**
 * NexSion build configuration.
 *
 * NOTE ON SECRECY: an OAuth *client ID* for a public client (browser extension)
 * is NOT a secret. It is visible to anyone who unzips the extension, exactly
 * like a web app's client ID is visible in page source. Google's security model
 * for public clients relies on the registered redirect URI, not on hiding the ID.
 *
 * It is kept here so it can be swapped per-environment at build time
 * (staging vs production client), not because it needs to be hidden.
 *
 * scripts/pack_crx.py replaces __NEXSION_CLIENT_ID__ with $NEXSION_CLIENT_ID
 * when that variable is set; otherwise the committed default below is used.
 */
const NEXSION_CONFIG = {
  // Replaced at build time when $NEXSION_CLIENT_ID is set.
  WEB_CLIENT_ID: "__NEXSION_CLIENT_ID__",

  OAUTH_SCOPES: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" "),
};

// Fall back to the committed default when no build-time value was injected.
if (NEXSION_CONFIG.WEB_CLIENT_ID.startsWith("__")) {
  NEXSION_CONFIG.WEB_CLIENT_ID =
    "248172709486-u2uk98ngsghobcqjc38sui0r2k2s3i0m.apps.googleusercontent.com";
}

self.NEXSION_CONFIG = NEXSION_CONFIG;
