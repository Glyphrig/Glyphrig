# Glyphrig Privacy Policy

**Last updated:** November 23, 2026

This Privacy Policy applies to the **Glyphrig** browser extension (`@glyphrig/extension`).

## Summary

Glyphrig is a local-first, open-source browser extension that synchronizes a single user-selected bookmark folder with a user-configured Git repository.

- **No developer servers:** Glyphrig has no backend servers, collects no analytics or telemetry, serves no ads, and never transmits data to the extension author or any third party.
- **Selective bookmark access:** Glyphrig never reads, syncs, or uploads your entire bookmark library—only the specific bookmark folder(s) you explicitly select in your sync profile(s).
- **Direct forge communication:** Your selected bookmarks and configuration are communicated **directly and exclusively** between your browser and the Git forge endpoint you configure (GitHub, GitLab, Forgejo/Codeberg/Gitea, or your self-hosted instance).

---

## Data Accessed & Stored Locally

All extension configuration and sync state are stored locally in your browser via `browser.storage.local` (never synced by Glyphrig to any developer-owned cloud):

1. **Selected Bookmark Folder Data**
   - Bookmark titles, URLs, folder structure, notes, and `#tags` within the specific bookmark folder(s) assigned to a sync profile.
2. **Sync Profile Settings & Credentials**
   - Forge type, repository owner/name, branch, repo folder path, optional custom instance URL, optional published site URL, and the scoped Personal Access Token or GitHub OAuth Device Flow token you provide.
   - Optional local override for a GitHub OAuth Client ID.
3. **Sync State & Logs**
   - Last-synced snapshots used solely for non-destructive 3-way conflict resolution, plus local sync history and conflict logs viewable in the extension's Settings page.

---

## How Data Is Transmitted

When a sync runs (manually, on a debounced edit, or via periodic alarm), the extension connects directly to the Git forge you configured (`api.github.com`, `github.com`, `gitlab.com`, `codeberg.org`, or an optional self-hosted URL you explicitly authorize):

- **Authentication:** If you use GitHub OAuth Device Flow, the extension communicates directly with `github.com` to request and poll a device authorization code.
- **Repository Sync:** Bookmark Markdown files (`bookmarks/<folder>/README.md`) are read from and committed directly to your target Git repository via that forge's official API.

> **Important Public Repository Notice:** If you configure Glyphrig to sync with a **public** Git repository (or publish it as a public static site), any bookmarks committed from your selected folder will be publicly visible on that repository and site. For private bookmarks, use a private repository.

---

## Built-In Public Safety Rails

To prevent accidental leaks when publishing bookmarks to Git, Glyphrig enables safety filters by default (configurable per profile):

- Skips non-public schemes (`file://`, `chrome://`, `about:`) and private/local addresses (`localhost`, LAN IPs, `*.local`).
- Skips URLs containing embedded credentials or sensitive query parameters (`token=`, `api_key=`, etc.).
- Strips common tracking parameters (`utm_*`, `fbclid`, `gclid`).
- Requires an explicit dry-run preview before committing the initial sync of a new profile.

---

## Data Retention & Deletion

You retain full control of all data at all times:

- **Clear logs:** Use **Clear Logs** in **Glyphrig Settings → Sync & Conflict Log** to wipe local sync history and conflict records.
- **Delete profiles:** Delete individual sync profiles in **Glyphrig Settings → Profiles** (which also removes that profile's stored token and snapshot).
- **Revoke access:** Revoke your Personal Access Token or authorized OAuth App directly from your Git provider's account settings.
- **Uninstall:** Uninstalling the extension removes all data stored in `browser.storage.local`.

---

## Source Code & Contact

Glyphrig is open-source software licensed under the MIT License:

- **Repository:** <https://github.com/Glyphrig/Glyphrig>
- **Support & Privacy Inquiries:** <https://github.com/Glyphrig/Glyphrig/issues>
