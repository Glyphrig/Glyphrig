# Glyphrig

**Glyphrig** is a browser extension + static site generator ecosystem for publishing and syncing a chosen bookmark folder across Desktop Chrome, Desktop Firefox, Firefox for Android, and phones (via an installable PWA) backed by a data-only Git repository.

## Key Features

- **Selective Two-Way Multi-Browser Sync (`apps/extension`):** Pick one specific bookmark folder per profile (never all bookmarks) and sync two-way across Chrome, Firefox, and Firefox for Android using 3-way merging with non-destructive conflict resolution.
- **Public Safety Rails:** Built-in filters block non-public schemes (`file://`, `chrome://`, `about:`), private/local IPs (`localhost`, LAN subnets), and credentialed/secret URLs, strip tracking parameters (`utm_*`, `fbclid`, `gclid`), and preview the initial sync before committing.
- **Human-Editable Markdown-per-Folder (`@glyphrig/core`):** Maps folders to `bookmarks/<folder>/README.md` with round-trip preservation of YAML frontmatter, intro prose, notes, and `#tags`.
- **Multi-Forge Support:** GitHub (PAT + OAuth Device Flow), GitLab, and Gitea / Forgejo / Codeberg (with self-hosted instance support).
- **Zero-Boilerplate Static Site (`@glyphrig/cli` + `@glyphrig/site`):** User repos hold only `bookmarks/` and `glyphrig.config.yaml` and run `npx @glyphrig/cli build` in CI (GitHub Actions, GitLab CI, Forgejo/Codeberg, Cloudflare Pages, Netlify, Vercel) to build an Editorial Digital Garden Astro site with cached link enrichment, local favicons, Pagefind search, RSS/JSON feeds, and a PWA Quick Add / Share Target.

## Monorepo Layout

| Package | Path | Purpose |
|---|---|---|
| `@glyphrig/core` | [`packages/core`](packages/core/package.json) | Pure TypeScript Markdown engine, URL safety rails, 3-way sync engine, and forge adapters |
| `@glyphrig/site` | [`packages/site`](packages/site/package.json) | Astro Editorial Digital Garden theme, feeds, Pagefind search, and PWA Quick Add |
| `@glyphrig/cli` | [`packages/cli`](packages/cli/package.json) | Published CLI (`glyphrig init \| build \| dev \| validate`) + cached URL enricher |
| `@glyphrig/extension` | [`apps/extension`](apps/extension/package.json) | WXT MV3 extension for Chrome, Firefox Desktop, and Firefox for Android |

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
