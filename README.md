# Glyphrig

**Glyphrig** is a browser extension + static site generator ecosystem for publishing and syncing a chosen bookmark folder across Desktop Chrome, Desktop Firefox, Firefox for Android, and phones (via an installable PWA) backed by a data-only Git repository.

## Key Features

- **4 Collaboration Sync Modes (`apps/extension`):** Pick one specific bookmark folder per profile (never all bookmarks) and sync via **Two-Way**, **Contribute-Only**, **Subscribe-Only** (read-only follow with zero token needed for public repos), or **Propose via Pull Request** (branch/fork PR workflow for community curation).
- **Live Team Page Indicator & Rich Save Popup:** Match the current tab locally against synced snapshots (zero network/telemetry) to see who saved it and read their notes, or save & annotate with `Alt+Shift+B`, repo tag autocomplete, and right-click context menus.
- **Per-Contributor Notes & Human-Editable Markdown (`@glyphrig/core`):** Maps folders to `bookmarks/<folder>/README.md` with round-trip preservation of YAML frontmatter (`maintainers`, `description`), intro prose, shared notes, indented per-contributor sub-notes (`  - **@alice**: ...`), `#tags`, and `archive=` Wayback links.
- **1-Click Garden Discovery (`glyphrig.json`):** Every published site emits `/glyphrig.json` and a **Join / Sync** modal with copyable invite codes that configure the extension in one click and reuse shared GitHub OAuth accounts.
- **Public Safety Rails & Interactive Conflict Resolver:** Blocks non-public/local/credentialed URLs, strips tracking params (`utm_*`, `fbclid`, `gclid`), enforces first-sync dry-run previews, and provides a side-by-side **Keep Mine / Keep Theirs / Merge Both** conflict UI.
- **Preservation, Migration & Digests (`@glyphrig/cli` + `@glyphrig/site`):** Includes `glyphrig import` (Netscape HTML, Raindrop, Pinboard, Pocket, Linkding, Karakeep), `glyphrig check-links` (dead-link detection + Wayback Machine snapshots), `glyphrig digest` (Markdown/Slack/Discord/Matrix/JSON), declarative `autoTagRules`, granular per-folder/tag/contributor RSS feeds, Pagefind search, and upgraded PWA Quick Add with zero-token Suggest-a-Link + bookmarklet/iOS Shortcut tools.

## Monorepo Layout

| Package | Path | Purpose |
|---|---|---|
| `@glyphrig/core` | [`packages/core`](packages/core/package.json) | Pure TypeScript Markdown engine (with contributor notes), safety rails, 4-mode sync engine, auto-tag rules, invite codec, and forge adapters |
| `@glyphrig/site` | [`packages/site`](packages/site/package.json) | Astro Editorial Digital Garden theme, `glyphrig.json` discovery, granular RSS/JSON feeds, Pagefind search, and PWA Quick Add / Suggest-a-Link |
| `@glyphrig/cli` | [`packages/cli`](packages/cli/package.json) | Published CLI (`glyphrig init \| build \| dev \| validate \| import \| check-links \| digest \| auto-tag \| theme`) + cached URL enricher |
| `@glyphrig/extension` | [`apps/extension`](apps/extension/package.json) | WXT MV3 extension for Chrome, Firefox Desktop, Firefox for Android, and Edge |

## Quick Start

Scaffold a new data-only bookmark repository for GitHub Pages (or GitLab, Forgejo/Codeberg, Cloudflare Pages, Netlify, Vercel):

```bash
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks
```

See the [Getting Started Guide](docs/GETTING_STARTED.md) for the complete setup walkthrough across browsers and mobile devices.

## Documentation

- [Getting Started Guide (Personal Setup)](docs/GETTING_STARTED.md)
- [Customizing & Authoring Themes](docs/THEMING.md)
- [Architecture Specification](docs/ARCHITECTURE.md)
- [GitHub OAuth Device Flow Setup Guide](docs/GITHUB_OAUTH_SETUP.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build

# Run extension in dev mode
pnpm dev:ext:chrome
pnpm dev:ext:firefox
```

## License

[MIT](LICENSE)
