# Getting Started with Glyphrig

Create your own data-only `glyphrig_bookmarks` repository in one command, publish it automatically via CI/CD, and sync a chosen bookmark folder two-way across Desktop Chrome, Desktop Firefox, Firefox for Android, and phones.

---

## Step 1: Scaffold Your Bookmark Repository

Run `glyphrig init` (no global install or template-repo fork required — your repo starts with clean git history and zero framework boilerplate):

```bash
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks
cd glyphrig_bookmarks
```

In an interactive terminal, `glyphrig init` prompts for your site title, description, author, CI/hosting provider, whether to include starter example bookmarks, and optional PWA Quick Add coordinates.

### Non-Interactive / Provider Flags

You can also skip prompts with `--yes` and select any CI/hosting target directly:

```bash
# GitHub Actions -> GitHub Pages (default)
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks --yes --ci github --title "My Bookmarks"

# GitLab CI -> GitLab Pages
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks --yes --ci gitlab --title "My Bookmarks"

# Forgejo / Codeberg Actions -> pages branch
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks --yes --ci forgejo --title "My Bookmarks"

# Cloudflare Pages / Netlify / Vercel / custom
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks --yes --ci cloudflare --title "My Bookmarks"

# Start completely empty (no sample bookmarks)
npx --yes @glyphrig/cli@0 init glyphrig_bookmarks --yes --no-examples
```

This creates:

```text
glyphrig_bookmarks/
├── .gitignore
├── README.md
├── glyphrig.config.yaml          # Site metadata, theme accent, enrichment & PWA Quick Add
├── bookmarks/
│   └── README.md                 # Root bookmarks (+ dev/, dev/web/, reading/ when examples enabled)
└── .github/workflows/deploy.yml  # Or .gitlab-ci.yml / .forgejo/workflows/deploy.yml per --ci
```

---

## Step 2: Initialize Git & Push to Your Forge

Create an **empty** public repository on GitHub, GitLab, or Codeberg (e.g. `glyphrig_bookmarks`), then push:

```bash
git init -b main
git add -A
git commit -m "chore: initial glyphrig_bookmarks setup"
```

### GitHub (`gh` CLI or `git remote`)

```bash
# Option 1: create and push in one command with GitHub CLI
gh repo create glyphrig_bookmarks --public --source=. --push

# Option 2: push to an already-created empty GitHub repo
git remote add origin git@github.com:<your-username>/glyphrig_bookmarks.git
git push -u origin main
```

### GitLab / Codeberg / Self-Hosted

```bash
git remote add origin git@codeberg.org:<your-username>/glyphrig_bookmarks.git
git push -u origin main
```

---

## Step 3: Customize `glyphrig.config.yaml` and `bookmarks/`

Edit `glyphrig.config.yaml`:

```yaml
site:
  title: My Public Bookmarks
  description: Curated links synced from my browsers via Glyphrig.
  author: Your Name
  # url: https://<your-username>.github.io
  # base: /glyphrig_bookmarks/ # Auto-inferred on GitHub Actions; set explicitly if needed

theme:
  accent: "#b45309"
  defaultView: list # "list" | "cards"

enrichment:
  enabled: true
  fetchFavicons: true
  fetchOgImage: true
  autoTags: false
  concurrency: 8
  timeoutMs: 5000
  ttlDays: 30

pwa:
  enabled: true
  quickAdd:
    enabled: false # Enable for mobile PWA Quick Add / Share Target
    forge: github
    owner: <your-username>
    repo: glyphrig_bookmarks
    branch: main
    rootDir: bookmarks
```

> **Security rule:** Never place Personal Access Tokens inside `glyphrig.config.yaml` or commit tokens to Git. `pwa.quickAdd` stores only public repository coordinates; your PAT lives strictly in that browser's `localStorage`.

---

## Step 4: Enable Static Site Publishing

- **GitHub Pages (`.github/workflows/deploy.yml`):**
  1. Open your repo's **Settings -> Pages**.
  2. Under **Build and deployment -> Source**, choose **GitHub Actions**.
  3. Trigger the workflow from **Actions -> Build & Deploy Glyphrig Site -> Run workflow** (or push a change under `bookmarks/`). Your site publishes to `https://<your-username>.github.io/glyphrig_bookmarks/` (or `/` if you add a `CNAME` file).
  4. The workflow caches `.glyphrig-cache` via `actions/cache@v4` and runs a weekly keep-warm schedule.
- **GitLab Pages (`.gitlab-ci.yml`):** Enabled automatically on push to `main`.
- **Codeberg / Forgejo Actions (`.forgejo/workflows/deploy.yml`):** Builds `./dist` and force-pushes to the `pages` branch.
- **Cloudflare Pages / Netlify / Vercel:** Connect your repo with build command `npx --yes @glyphrig/cli@0 build --base /`, output directory `dist`, and `NODE_VERSION=22`.

---

## Step 5: Install & Connect the Browser Extension

Download the latest release bundles from [`Glyphrig` Releases](https://github.com/Glyphrig/Glyphrig/releases):

- **Desktop Chrome / Brave / Edge:** unzip `glyphrigextension-*-chrome.zip`, open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
- **Desktop Firefox:** load `glyphrigextension-*-firefox.zip` via `about:debugging` (or the signed AMO build).
- **Firefox for Android:** install the signed Firefox release (`gecko_android` is configured in the MV3 manifest).

Configure a sync profile in each browser:

1. Create a dedicated folder inside your bookmarks bar/toolbar (e.g., `Bookmarks Bar/Public Bookmarks`). Glyphrig intentionally disables top-level browser roots so private bookmarks are never synced.
2. Open **Glyphrig Settings -> Profiles**, set:
   - **Forge:** `GitHub` (or `GitLab` / `Forgejo / Codeberg`)
   - **Owner / Group:** `<your-username>`
   - **Repository:** `glyphrig_bookmarks`
   - **Branch:** `main`
   - **Repo Folder:** `bookmarks`
   - **Published Site URL:** e.g. `https://<your-username>.github.io/glyphrig_bookmarks/`
3. **Authenticate:**
   - **GitHub OAuth Device Flow:** Click **Sign in with GitHub**, copy the 8-character code, and approve at `github.com/login/device`.
   - **Or Fine-Grained PAT:** Scope it strictly to `<your-username>/glyphrig_bookmarks` with **Contents: Read and write** (tokens stay solely in `browser.storage.local`).
4. Click **Test Connection** to confirm repo and branch access.
5. Select `Public Bookmarks` in the **Synced Bookmark Folder** picker.
6. Keep all four **Safety Rails** enabled, click **Preview Sync (Dry-Run)**, verify the proposed pushes/pulls/skips, and click **Confirm & Sync**.

---

## Step 6: Add Additional Devices & Local Preview

- **Laptop, Desktop & Firefox Android:** Install the extension, create an empty `Public Bookmarks` folder, point it at the same `glyphrig_bookmarks` repo and `main` branch, and confirm the initial dry-run preview to pull everything into sync two-way (60s debounced push, 15m periodic pull, plus startup pull).
- **iOS / Chrome Android:** Set `pwa.quickAdd.enabled: true` in `glyphrig.config.yaml` with your repo coordinates, install your published site to your home screen, and use **+ Quick Add** (or Android Share Target) with a scoped PAT stored locally in that browser.
- **Local preview & validation anytime:**
  ```bash
  npx --yes @glyphrig/cli@0 validate
  npx --yes @glyphrig/cli@0 dev
  ```
