# Customizing & Authoring Glyphrig Themes

Glyphrig separates your bookmark data (`bookmarks/**/README.md`) from site presentation so you can restyle or completely redesign your bookmark directory without touching your links or breaking browser sync.

You can customize your site at **four levels**, depending on how much control you want:

1. **Built-in theme presets & config knobs** — zero CSS required
2. **Lightweight CSS & `<head>` overrides** — tweak colors, fonts, or spacing in a single file
3. **Reusable CSS theme directory** — bundle `theme.yaml`, `theme.css`, `head.html`, and `assets/`
4. **Full custom Astro theme (or ejected default theme)** — own 100% of the HTML, layouts, and pages with zero local `node_modules` required

---

## 1. Built-in Theme Presets

List all built-in themes from the CLI:

```bash
npx --yes @glyphrig/cli@0 theme list
```

| Preset | Style | Default Color Scheme | Default Accent |
|---|---|---|---|
| `editorial` *(default)* | Warm cream paper / charcoal dark, serif display headings | `system` | `#b45309` |
| `minimal` | Crisp monochrome, geometric sans-serif headings, hairline borders | `system` | `#2563eb` |
| `terminal` | Dark-first phosphor monochrome, monospace UI & headings, crisp corners | `dark` | `#22c55e` |
| `nord` | Arctic slate-blue palette inspired by Nord (light & dark) | `system` | `#5e81ac` |

Select a preset in `glyphrig.config.yaml`:

```yaml
theme:
  use: terminal
  # Omit `accent` and `colorScheme` to inherit the theme's defaults,
  # or set them explicitly to override:
  # accent: "#38bdf8"
  # colorScheme: dark   # "system" | "light" | "dark"
  defaultView: list     # "list" | "cards"
```

Shorthand is also supported if you only want to choose a theme:

```yaml
theme: nord
```

You can preview any theme without editing `glyphrig.config.yaml` using `--theme`:

```bash
npx --yes @glyphrig/cli@0 dev --theme terminal
npx --yes @glyphrig/cli@0 build --theme ./theme
```

---

## 2. Quick CSS & `<head>` Overrides

For targeted tweaks on top of any built-in or custom theme, add `customCss` and/or `customHead` in `glyphrig.config.yaml`:

```yaml
theme:
  use: editorial
  accent: "#0f766e"
  colorScheme: system
  defaultView: list
  customCss: assets/custom.css
  customHead: assets/head.html
```

- `assets/favicon.svg` (if present) automatically replaces the default bookmark icon.
- Everything inside `assets/` is copied to `dist/assets/`.
- Inside `customHead` (and theme `head.html`), `{{base}}` is automatically replaced with your site's base path (for example `/` on a custom domain, or `/glyphrig_bookmarks/` on GitHub Pages).

### Example: Custom Fonts (`assets/head.html` + `assets/custom.css`)

```html
<!-- assets/head.html -->
<link rel="preconnect" href="https://fonts.bunny.net" />
<link
  href="https://fonts.bunny.net/css?family=fraunces:600,700|inter:400,500,600|jetbrains-mono:400"
  rel="stylesheet"
/>
```

```css
/* assets/custom.css */
:root {
  --font-serif: 'Fraunces', Georgia, serif;
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --radius: 12px;
}
```

### CSS Custom Properties Reference

Glyphrig's default stylesheet exposes these variables on `:root` (light mode) and `html[data-theme='dark']` (dark mode):

| Variable | Purpose | Default (Light) | Default (Dark) |
|---|---|---|---|
| `--bg` | Page & sidebar background | `#faf8f5` | `#101216` |
| `--surface` | Card, input & modal surface | `#ffffff` | `#171a21` |
| `--surface-muted` | Pill, tag & hover fill | `#f2ede4` | `#1f242e` |
| `--ink` | Primary text color | `#1c1917` | `#ece9e4` |
| `--ink-muted` | Secondary metadata & labels | `#57534e` | `#9ca3af` |
| `--border` | Hairlines & dividers | `#e4dcd0` | `#282e3a` |
| `--accent` | Primary accent & focus rings | `#b45309` | `#b45309` |
| `--accent-soft` | Subtle highlight tint | `color-mix(in srgb, var(--accent) 12%, transparent)` | `18%` mix |
| `--font-serif` | Brand, page & section headings | `Georgia, 'Iowan Old Style', ...` | inherited |
| `--font-sans` | Body & UI controls | `system-ui, -apple-system, ...` | inherited |
| `--font-mono` | Counts, dates, tags & handles | `ui-monospace, SFMono-Regular, ...` | inherited |
| `--radius` | Card & control border radius | `10px` | inherited |
| `--sidebar-width` | Desktop sidebar column width | `270px` | inherited |

### Key Structural Classes

- Shell: `.app-shell`, `.sidebar`, `.mobile-bar`, `.content-wrap`, `.page-main`
- Navigation: `.brand-link`, `.brand-title`, `.search-trigger`, `.nav-section-title`, `.nav-item-link`, `.folder-tree`, `.sidebar-footer`
- Header & controls: `.breadcrumbs`, `.page-header`, `.page-title`, `.page-subtitle`, `.view-controls`, `.pill-btn`
- Bookmarks: `.bookmark-collection[data-view="list" | "cards"]`, `.bookmark-item`, `.bm-title`, `.bm-domain`, `.bm-note`, `.bm-tag`, `.bm-popularity`, `.bm-contributor`
- Modals: `.search-dialog`, `.quickadd-dialog`, `.empty-state`

### Stylesheet Cascade Order

When building, Glyphrig composes the stylesheet in deterministic order:

1. Base layout CSS (skipped when a CSS theme sets `mode: replace`)
2. Active theme CSS (built-in preset or `theme/theme.css`)
3. Explicit `theme.accent` from `glyphrig.config.yaml` (if set)
4. User's `theme.customCss` (always wins last)

---

## 3. Creating a Reusable CSS Theme Directory

Scaffold a custom CSS theme right inside your bookmark repository:

```bash
npx --yes @glyphrig/cli@0 theme init theme
```

This creates:

```text
theme/
├── theme.yaml   # Metadata, mode ("extend" | "replace"), and default accent/colorScheme/view
├── theme.css    # Theme stylesheet (pre-populated with all light & dark CSS variables)
└── head.html    # Optional HTML injected into <head> (supports {{base}})
```

You can also add `theme/assets/` (for local fonts, background patterns, or icons); Glyphrig copies it to `dist/theme-assets/` during builds and serves it under `/theme-assets/` during `glyphrig dev`.

### `theme.yaml` Manifest Reference

```yaml
name: Oceanic
description: Deep teal bookmark theme
version: 1.0.0

# "extend"  (default) -> layers theme.css on top of Glyphrig's base layout CSS
# "replace"           -> omits Glyphrig's base CSS so theme.css owns 100% of styling
# "astro"             -> full Astro template theme (auto-detected if src/pages/ exists)
mode: extend

# Optional custom relative paths inside the theme folder:
css: theme.css
head: head.html
assetsDir: assets

# Optional defaults (used unless explicitly overridden in glyphrig.config.yaml):
defaults:
  accent: "#0f766e"
  colorScheme: system  # "system" | "light" | "dark"
  defaultView: list    # "list" | "cards"
```

Activate the theme in `glyphrig.config.yaml`:

```yaml
theme:
  use: ./theme
```

> **Tip:** You can also point `theme.use` directly at a single standalone CSS file (for example `theme: { use: ./my-skin.css }`).

---

## 4. Creating a Full Custom Astro Theme (or Ejecting the Default Theme)

If you want complete control over HTML markup, page routes, layouts, and components, supply an Astro theme directory. Your bookmark repository still needs **zero `package.json` and zero `node_modules`** — `@glyphrig/cli` provides Astro, Vite, Pagefind, URL enrichment, favicons, and PWA `sw.js` automatically.

### Option A: Start from a Minimal Astro Theme Starter

```bash
npx --yes @glyphrig/cli@0 theme init theme --type astro
```

This scaffolds a clean starter theme with:

```text
theme/
├── theme.yaml
└── src/
    ├── env.d.ts
    ├── styles/theme.css
    └── pages/
        ├── index.astro
        ├── f/[...folder].astro
        └── rss.xml.ts
```

### Option B: Eject the Full Default Theme

To keep every built-in feature (nested sidebar tree, Pagefind search modal, `/recent/`, `/popular/`, `/tags/`, `/u/<user>/`, RSS/JSON feeds, PWA manifest, and Quick Add drawer) and modify individual components:

```bash
npx --yes @glyphrig/cli@0 theme eject theme
```

Then activate it in `glyphrig.config.yaml`:

```yaml
theme:
  use: ./theme
```

### Virtual Modules Available to Custom Astro Themes

Glyphrig injects three virtual modules into any custom Astro theme:

1. **`virtual:glyphrig-data`** — exports `siteData` (`GlyphrigSiteData`):
   - `siteData.config` — resolved `SiteConfig` (`site`, `theme`, `enrichment`, `pwa`)
   - `siteData.root` — root `EnrichedFolderNode` tree
   - `siteData.flatFolders` — flat list of all nested folders (for `getStaticPaths()` in `f/[...folder].astro`)
   - `siteData.allBookmarks` — all `EnrichedBookmark[]` (`title`, `url`, `domain`, `tags`, `note`, `effectiveDescription`, `ogImage`, `faviconPath`, `savedBy`, `globalSavedBy`, `popularity`, `folderPath`, `folderTitle`, `added`)
   - `siteData.tags` — `TagSummary[]` (`tag`, `slug`, `count`)
   - `siteData.contributors` — `ContributorSummary[]` (`username`, `slug`, `count`)
   - `siteData.themeName`, `siteData.customCssContent`, `siteData.customHeadContent`, `siteData.hasCustomFaviconAsset`, `siteData.generatedAt`

2. **`virtual:glyphrig-helpers`** — exports ready-to-use helpers bound to `siteData`:
   - `withBase(path)`, `normalizeBase(base)`
   - `folderHref(folderPath)`, `tagHref(tagSlug)`, `contributorHref(userSlug)`
   - `findFolderByPath(folderPath)`, `getFolderBreadcrumbs(folder)`
   - `collectTagsInBookmarks(bookmarks)`
   - `sortRecentBookmarks(bookmarks)`, `sortPopularBookmarks(bookmarks)`, `deduplicateBookmarksByUrl(bookmarks)`
   - `escapeXml(str)`

3. **`virtual:glyphrig-theme.css`** — composed CSS stylesheet (optional; custom Astro themes can either `import 'virtual:glyphrig-theme.css'` or import their own local CSS directly).

> **Pagefind Search Tip:** Add `data-pagefind-body` to your main bookmark list container so Pagefind indexes your bookmark content accurately and skips chrome/nav noise.

---

## 5. Sharing & Installing Themes as npm Packages

Anyone can publish a CSS or Astro Glyphrig theme to npm:

1. Put `theme.yaml` and either `theme.css` or `src/pages/` in the package root (or specify `"glyphrigTheme": "./dist"` in `package.json`).
2. Users install the package in their environment/repo (or CI step) and reference it by package name:

```yaml
theme:
  use: glyphrig-theme-ocean
```

---

## 6. Deploying Custom Themes in GitHub Actions

Newly initialized repos include `"theme/**"` in `.github/workflows/deploy.yml`'s `on.push.paths`. If you created your repo before `0.3.6` and add a local `theme/` directory, make sure `.github/workflows/deploy.yml` includes `"theme/**"`:

```yaml
on:
  push:
    branches:
      - main
    paths:
      - "bookmarks/**"
      - "glyphrig.config.yaml"
      - "assets/**"
      - "theme/**"
      - ".github/workflows/deploy.yml"
```

Always verify your theme configuration before pushing:

```bash
npx --yes @glyphrig/cli@0 validate
npx --yes @glyphrig/cli@0 dev
```
