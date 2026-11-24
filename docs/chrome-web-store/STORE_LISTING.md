# Glyphrig — Chrome Web Store Listing & Privacy Reference

Use the copy below when filling out the **Chrome Web Store Developer Dashboard** for **Glyphrig** (`@glyphrig/extension`).

---

## 1. Store Listing Tab

### Extension Name (max 45 characters)

- **Primary (8 chars):**
  ```text
  Glyphrig
  ```
- **SEO-friendly alternative (28 chars):**
  ```text
  Glyphrig — Git Bookmark Sync
  ```

### Short Description / Summary (max 132 characters)

Matches `apps/extension/wxt.config.ts` (`129` characters):

```text
Two-way sync a chosen bookmark folder with a Git repository (GitHub, GitLab, Forgejo/Codeberg) to publish a static bookmark site.
```

### Detailed Description (plain-text formatted for CWS)

```text
Glyphrig turns a single chosen browser bookmark folder into a two-way Git-backed knowledge archive—and optionally lets you publish it as a searchable static bookmark site.

Instead of locking your bookmarks inside one browser or uploading your entire private bookmark bar to a third-party cloud, Glyphrig syncs only the specific folder(s) you choose directly to your own Git repository as clean, human-editable Markdown.

KEY FEATURES

• Selective Folder Sync
Pick one specific bookmark folder per profile. Glyphrig never touches, reads, or syncs the rest of your bookmarks.

• True Two-Way 3-Way Merge (Plus Contribute-Only Mode)
Keep a bookmark folder mirrored across your browsers and devices with non-destructive conflict resolution—or choose Contribute-only mode to push your bookmarks to a shared repository without pulling others into your browser.

• Multi-Forge Git Support
Connect directly to GitHub (via OAuth Device Flow or a Personal Access Token), GitLab, or compatible self-hosted Git servers such as Forgejo and Gitea.

• Human-Editable Markdown-per-Folder
Maps each synced subfolder to bookmarks/<folder>/README.md while preserving YAML frontmatter, intro prose, notes, and #tags on every round-trip.

• Built-In Public Safety Rails
Automatically protects you from accidental leaks before pushing to Git:
  - Skips non-public URLs (localhost, LAN IPs, *.local, file://, chrome://)
  - Skips URLs with embedded credentials or secret query params (token=, api_key=)
  - Strips tracking query parameters (utm_*, fbclid, gclid)
  - Requires a Dry-Run Preview before committing the initial sync of any profile

• Multi-Profile & Backups
Configure multiple independent profiles (different bookmark folders to different repositories), customize push debounce and periodic pull intervals, inspect sync and conflict logs, and export/import JSON configuration backups.

• Optional Static Bookmark Site
Pair your synced bookmark repository with the optional @glyphrig/cli site generator to build a searchable static bookmark directory with RSS/JSON feeds and local favicons for any static web host.

• Local-First & Open Source
MIT licensed, zero telemetry, zero ads, and no intermediary backend—your browser communicates directly with your configured Git server.

QUICK SETUP

1. Open Glyphrig Settings and create a sync profile.
2. Select your Git forge, repository, branch, and authenticate via GitHub OAuth Device Flow or a scoped Personal Access Token.
3. Choose the single browser bookmark folder to sync, run a Dry-Run Preview, and click Confirm & Sync.
```

### Store Metadata

- **Category:** `Productivity` *(or `Developer Tools`)*
- **Language:** `English`
- **Official URL / Homepage:** `https://glyphrig.github.io/Glyphrig/` *(or `https://github.com/Glyphrig/Glyphrig`)*
- **Support URL:** `https://github.com/Glyphrig/Glyphrig/issues`

---

## 2. Privacy Practices Tab

### Single Purpose Description

```text
Two-way synchronize a user-selected browser bookmark folder with a user-configured Git repository (GitHub, GitLab, or Forgejo/Codeberg/Gitea) as human-editable Markdown files, with built-in URL safety filtering.
```

### Permission Justifications

Matches `apps/extension/wxt.config.ts`:

- **`bookmarks`**
  ```text
  Required to list selectable bookmark folders in Settings and to read, create, update, move, or remove bookmarks exclusively inside the specific bookmark folder(s) chosen by the user for synchronization.
  ```

- **`storage`**
  ```text
  Required to store user sync profile settings, scoped Git access tokens (kept locally in browser.storage.local only), last-sync snapshots for 3-way conflict resolution, and local sync/conflict history logs.
  ```

- **`alarms`**
  ```text
  Required to schedule debounced pushes after bookmark edits and periodic background pulls so selected folders remain synchronized when the Manifest V3 service worker suspends.
  ```

- **`host_permissions` (`https://api.github.com/*`, `https://github.com/*`, `https://gitlab.com/*`, `https://codeberg.org/*`)**
  ```text
  Required to complete GitHub OAuth Device Flow authentication and directly read/commit Markdown bookmark files to the user's configured Git repository using each forge's official REST API, without routing through any third-party backend.
  ```

- **`optional_host_permissions` (`https://*/*`, `http://*/*`)**
  ```text
  Requested only on demand if the user explicitly configures a self-hosted GitLab, Forgejo, or Gitea instance URL in a sync profile.
  ```

### Remote Code

- Select: **`No, I am not using Remote code`**
  *(All JavaScript/TypeScript is bundled into the extension package at build time via WXT/Vite.)*

### Data Usage Disclosures

- **Collected / Handled Data Types:**
  - **Authentication information** — User-supplied Personal Access Tokens or GitHub OAuth Device Flow tokens, stored locally in `browser.storage.local` and sent only to the configured Git forge API.
  - **Website content / User activity (Bookmarks)** — Bookmark titles, URLs, notes, and folder hierarchy strictly within the user-selected bookmark folder(s), synchronized directly to the user's configured Git repository.
  - All other categories (Personally identifiable info, Health, Financial, Location, Personal communications, etc.): **Unchecked**.
- **Limited Use Certifications (check all 3):**
  - Data is **not** sold to third parties.
  - Data is **not** used or transferred for purposes unrelated to the item's single purpose.
  - Data is **not** used or transferred to determine creditworthiness or for lending purposes.

### Privacy Policy URL

Deploy `apps/githubio` to GitHub Pages (or commit `docs/PRIVACY.md` to `main`) and enter:

```text
https://glyphrig.github.io/Glyphrig/privacy/
```

Raw Markdown mirror: `https://glyphrig.github.io/Glyphrig/PRIVACY.md` (or `https://github.com/Glyphrig/Glyphrig/blob/main/docs/PRIVACY.md`).

---

## 3. Asset Inventory & Upload Checklist

| CWS Dashboard Slot | Required Spec | Ready File | Verified Output |
| :--- | :--- | :--- | :--- |
| **Extension Package** | Manifest V3 `.zip` | `apps/extension/.output/glyphrigextension-0.4.5-chrome.zip` | Built via `pnpm --filter @glyphrig/extension zip` |
| **Store Icon** | `128×128` PNG (RGBA, padded) | `docs/chrome-web-store/assets/store-icon-128x128.png` | `128×128` RGBA (`TrueColorAlpha`, 12px padding) |
| **Small Promo Tile** | `440×280` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/promo-small-440x280.png` | `440×280` RGB (`TrueColor`, PNG24) |
| **Marquee Promo Tile** | `1400×560` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/promo-marquee-1400x560.png` | `1400×560` RGB (`TrueColor`, PNG24) |
| **Screenshot 1** | `1280×800` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/screenshot-1-popup-and-sync.png` | `1280×800` RGB (`TrueColor`, PNG24) |
| **Screenshot 2** | `1280×800` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/screenshot-2-multi-forge-settings.png` | `1280×800` RGB (`TrueColor`, PNG24) |
| **Screenshot 3** | `1280×800` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/screenshot-3-safety-rails-preview.png` | `1280×800` RGB (`TrueColor`, PNG24) |
| **Screenshot 4** | `1280×800` PNG/JPEG (no alpha) | `docs/chrome-web-store/assets/screenshot-4-editorial-digital-garden.png` | `1280×800` RGB (`TrueColor`, PNG24) |
| **Toolbar / Manifest Icons** | `16`, `32`, `48`, `128` PNG (RGBA) | `apps/extension/public/icon/{16,32,48,128}.png` | Bundled inside extension ZIP |

