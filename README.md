# Extension ↔ Website auth sync — patch

Replace these 3 files in the **NexSion extension repo** (not the website):

- `manifest.json`
- `background.js`
- `js/cloudSync.js`

## What changed

**`manifest.json`** — added `externally_connectable`, listing which website
origins are allowed to message the extension. **Edit the placeholder** before
using this:

```json
"externally_connectable": {
  "matches": [
    "https://YOUR-VERCEL-DOMAIN.vercel.app/*",
    "http://localhost:3000/*"
  ]
}
```

Swap `YOUR-VERCEL-DOMAIN.vercel.app` for your real deployed domain. Only
origins listed here can talk to the extension — this is a real security
boundary, not just documentation.

**`background.js`** — now also `importScripts("js/cloudSync.js")`, and adds a
`chrome.runtime.onMessageExternal` listener that only the origins above can
reach. It handles 3 message types:

| `message.type` | What it does |
|---|---|
| `nexsion-get-auth-state` | Returns `{ signedIn, user }` — lets the website check "is this browser already signed in?" without a popup |
| `nexsion-adopt-session` | Saves a `{uid, idToken, refreshToken, expiresAt}` session pushed from the website's own Firebase sign-in, then pulls the account's cloud backup |
| `nexsion-sign-out` | Clears the cloud session only — does **not** wipe local boards, unlike the newtab page's own "Sign Out" button (which shows a confirm dialog first) |

**`js/cloudSync.js`** — added `CloudSync.adoptExternalSession()` and
`CloudSync.signOutExternal()` (the two functions background.js calls above),
plus an explicit `self.CloudSync = CloudSync;` at the end. Everything else in
the file is untouched.

## After merging

1. Bump `manifest.json`'s version (this patch counts as a real change).
2. Push to `main` — the release workflow from before picks it up and
   publishes the update automatically.
3. Once people update to this version, the website's sign-in can talk to
   their extension.

## How the sync actually behaves

- **Website login → extension login: fully automatic**, no extra click in
  the extension. The website does its own Google sign-in (Firebase popup),
  then silently pushes that session to the extension via
  `nexsion-adopt-session`.
- **Extension already signed in → website mirrors it automatically**, but
  only **in the same browser** the extension is installed in. On page load
  (and on window focus), the website asks the extension for its current
  session and displays that instead of showing its own sign-in button.
- **Different browser/device**: there's no channel between them — browsers
  can't message each other across machines. Signing in stays required on
  each one separately there, same as any account system.
- **Sign out** on the website also asks the extension to sign out (cloud
  session only, boards stay on-device), so both stay in the same state.
