# Extension auto-release workflow

This is a **GitHub Actions workflow for the NexSion extension repo**
(`NexSion/NexSion`) — not the website. Copy the `.github` folder in here into
the root of that repo (alongside `manifest.json`).

## What it does

Every time you push a commit to `main` that changes `manifest.json`'s
`"version"` field, it automatically:

1. Reads the new version number from `manifest.json`.
2. Updates `Release.json`'s `version` field and `Update.json`'s
   `latestVersion` + `zipUrl` to match — so the extension's built-in
   self-updater (`js/updater.js`) picks up the new release with zero manual
   file edits.
3. Commits that sync back to `main`.
4. Zips the whole repo (minus `.git`, `.github`, markdown files, etc.) into
   `NexSion_v<version>.zip`.
5. Creates a GitHub Release tagged `v<version>`, with that zip attached and
   `Release.json`'s `notes` as the release body.

The website's `/api/download` route always redirects to whatever the
**latest** GitHub Release's `.zip` asset is — so once this workflow publishes
a new release, the site's "Get the extension" button picks it up automatically
within a few minutes (it caches for 5 minutes), no website deploy needed.

## Your release checklist becomes

1. Edit `Release.json`'s `"notes"` field with what changed.
2. Bump `"version"` in `manifest.json`.
3. Push to `main`.

That's it — the zip, the GitHub Release, `Update.json`, and the website's
download link all update themselves.

## One-time setup

Nothing extra needed — this uses the repo's built-in `GITHUB_TOKEN`, which
already has permission to push commits and create releases as long as the
workflow has `permissions: contents: write` (already set in the file) and
your repo's Settings → Actions → General → "Workflow permissions" is set to
"Read and write permissions".

## Note on the "Get it here" link inconsistency

`share-preview.html` currently points to `github.com/nexerisltd/NexSion`
while everything else (the updater, the invite message, `updates.xml`) points
to `github.com/NexSion/NexSion`. Worth fixing that link to match — the
website's `lib/site-config.js` assumes `NexSion/NexSion` is the real one.
