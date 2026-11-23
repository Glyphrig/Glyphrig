# Glyphrig Architecture Specification

Glyphrig is a two-way multi-browser bookmark synchronization extension paired with a data-only Git repository and a published static site generator (`@glyphrig/cli` + `@glyphrig/site`).

## 1. System Overview

```text
  Desktop Chrome / Firefox / Firefox Android (WXT MV3 Extension)
  Phone iOS / Chrome Android (Astro PWA Share Target + PAT Quick Add)
                 │
                 ▼
       @glyphrig/core (Pure TypeScript, zero Node builtins)
         ├── Round-Trip Markdown Parser & Serializer
         ├── URL Sanitizer & Safety Rails
         ├── 3-Way Sync Engine (Non-destructive conflict resolution)
         └── Forge Adapters (GitHub / GitLab / Forgejo + GitHub Device Flow)
                 │
                 ▼  (Atomic multi-file commits)
       User Bookmark Repo (Data-Only)
         ├── bookmarks/**/README.md
         ├── glyphrig.config.yaml
         └── CI/CD Workflow (GitHub Actions / GitLab CI / Forgejo / Cloudflare)
                 │
                 ▼  (npx @glyphrig/cli build)
       @glyphrig/cli + @glyphrig/site
         ├── Cached URL Enricher & Local Favicon Fetcher (--cache-dir)
         ├── Astro Static Site (Editorial Digital Garden theme)
         ├── Pagefind Full-Text Index
         └── PWA Manifest + Offline Service Worker + RSS/JSON Feeds
```

## 2. Monorepo Packages

- **`packages/core` (`@glyphrig/core`)**: Zero-Node-dependency core library shared across browser extensions, the Astro PWA client island, and the Node CLI.
- **`packages/site` (`@glyphrig/site`)**: Astro static site template implementing the Editorial Digital Garden theme, nested folder/tag/popular/contributor pages, Pagefind search modal, RSS/JSON feeds, and PWA Quick Add drawer.
- **`packages/cli` (`@glyphrig/cli`)**: Published CLI (`glyphrig init | build | dev | validate | theme`) that scaffolds data-only bookmark repos, resolves built-in or user-supplied CSS/Astro themes (see [THEMING.md](./THEMING.md)), validates `glyphrig.config.yaml`, parses `bookmarks/**/README.md`, enriches URLs with disk caching, injects data via `virtual:glyphrig-data` / `virtual:glyphrig-helpers` / `virtual:glyphrig-theme.css` into Astro without mutating `node_modules`, and emits the static site + Pagefind index + `sw.js`.
- **`apps/extension` (`@glyphrig/extension`)**: WXT MV3 browser extension targeting Desktop Chrome, Desktop Firefox, and Firefox for Android (`gecko_android`).

## 3. Markdown-per-Folder Data Contract

- Every synced folder maps to `bookmarks/<slug-path>/README.md` (root folder: `bookmarks/README.md`).
- Directory slugs are lowercase ASCII URL-safe strings (`Dev Tools & CLI` -> `dev-tools-cli`), with deterministic `-2`, `-3` suffixes for sibling collisions.
- YAML frontmatter preserves exact `title`, sibling `order`, and any extra user-authored metadata (`description`, etc.).
- Bookmark line syntax:
  ```markdown
  - [Astro](https://astro.build) — Fast static site framework `#web` `#ssg` <!-- glyphrig: added=2026-11-21 by=alice,bob -->
  ```
- Surrounding hand-written prose blocks, comments, and bookmark notes/tags are preserved round-trip across two-way browser syncs.
- Deletions are non-destructive: when a bookmark has no remaining contributors saving it, it moves to `<folder>/.archived/README.md` with `archived=YYYY-MM-DD` metadata rather than being permanently deleted (and is excluded from the public static site).

## 4. Sync Modes, Multi-User Merging & Public Safety Rails

1. **Non-public URL filter**: Skips `file:`, `chrome:`, `about:`, `javascript:`, `moz-extension:`, `data:`, and private/local hosts (`localhost`, `*.local`, `*.internal`, RFC1918, loopback, link-local, ULA IPv6).
2. **Credential & sensitive-param filter**: Skips `user:pass@` URLs and query keys like `token`, `api_key`, `secret`, `password`, `jwt`, `session`.
3. **Tracking-parameter stripping**: Strips `utm_*`, `fbclid`, `gclid`, `si`, etc., updating the local browser URL under echo suppression so diffs stay clean.
4. **First-sync dry-run preview**: New profiles run a dry-run merge and show exact pushes, pulls, archives, and skipped URLs before committing.

Profiles support two sync modes:
- **`two-way` (default)**: Mirrors the shared repository and the chosen browser folder cleanly in both directions.
- **`contribute-only`**: Pushes the user's own additions, attribution, and un-saves into the shared repository without pulling teammates' links into the user's browser folder or deleting teammates' links.

When multiple collaborators save the same normalized URL, Glyphrig merges their contributor handles (`by=alice,bob`), unions `#tags`, combines distinct notes idempotently, and preserves the earliest `added` date. The static site ranks unique URLs across folders on `/popular/` and groups each contributor's links on `/u/<username>/`.

Conflict resolution uses a 3-way merge against `{ lastSyncedCommitSha, lastSyncedTree }`:
- Edit vs. Delete -> **keep edited bookmark** (`kept-edited`).
- Edit vs. Edit (title or destination folder) -> **remote wins** (`remote-won`).
- All conflicts are logged to local sync history.
