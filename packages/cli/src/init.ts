import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeKind } from '@glyphrig/core';
import YAML from 'yaml';

export const INIT_CI_PROVIDERS = [
  'github',
  'gitlab',
  'forgejo',
  'cloudflare',
  'netlify',
  'vercel',
  'none',
  'all',
] as const;

export type InitCiProvider = (typeof INIT_CI_PROVIDERS)[number];

export interface InitQuickAddOptions {
  enabled: boolean;
  forge: ForgeKind;
  owner: string;
  repo: string;
  branch?: string;
  instanceUrl?: string;
}

export interface InitBookmarkRepoOptions {
  targetDir: string;
  ci?: InitCiProvider;
  title?: string;
  description?: string;
  author?: string;
  accent?: string;
  examples?: boolean;
  quickAdd?: InitQuickAddOptions;
  force?: boolean;
}

export interface InitBookmarkRepoResult {
  targetDir: string;
  ci: InitCiProvider;
  created: string[];
  skipped: string[];
}

const GITIGNORE_CONTENT = `.glyphrig-cache/
dist/
public/
.DS_Store
`;

const GITHUB_DEPLOY_WORKFLOW = `name: Build & Deploy Glyphrig Site

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
  schedule:
    # Weekly keep-warm run to preserve enrichment cache & refresh stale metadata
    - cron: "0 6 * * 0"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Restore enrichment cache
        uses: actions/cache@v4
        with:
          path: .glyphrig-cache
          key: glyphrig-cache-\${{ github.ref_name }}-\${{ hashFiles('bookmarks/**/README.md') }}
          restore-keys: |
            glyphrig-cache-\${{ github.ref_name }}-
            glyphrig-cache-

      - name: Build static site with @glyphrig/cli
        run: npx --yes @glyphrig/cli@0 build --cache-dir .glyphrig-cache

      - name: Upload GitHub Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

const GITLAB_CI_YAML = `# GitLab Pages pipeline for Glyphrig
# For project repos (not <username>.gitlab.io), \`--base "/$CI_PROJECT_NAME/"\` is set below.

image: node:22-slim

pages:
  stage: deploy
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  cache:
    key: glyphrig-enrichment-cache
    paths:
      - .glyphrig-cache/
  script:
    - |
      if [ "$CI_PROJECT_PATH" != "\${CI_PROJECT_NAMESPACE}.gitlab.io" ]; then
        npx --yes @glyphrig/cli@0 build --out public --cache-dir .glyphrig-cache --base "/$CI_PROJECT_NAME/"
      else
        npx --yes @glyphrig/cli@0 build --out public --cache-dir .glyphrig-cache
      fi
  artifacts:
    paths:
      - public
`;

const FORGEJO_DEPLOY_WORKFLOW = `# Forgejo / Codeberg / Gitea Actions workflow deploying ./dist to the \`pages\` branch.

name: Build & Deploy Glyphrig Site

on:
  push:
    branches:
      - main
    paths:
      - "bookmarks/**"
      - "glyphrig.config.yaml"
      - "assets/**"
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - uses: actions/cache@v4
        with:
          path: .glyphrig-cache
          key: glyphrig-cache-\${{ hashFiles('bookmarks/**/README.md') }}
          restore-keys: |
            glyphrig-cache-

      - name: Build static site
        run: npx --yes @glyphrig/cli@0 build --cache-dir .glyphrig-cache

      - name: Publish dist/ to pages branch
        run: |
          cd dist
          git init -b pages
          git config user.name "glyphrig-bot"
          git config user.email "actions@users.noreply.codeberg.org"
          git add -A
          git commit -m "Deploy Glyphrig static site"
          git push --force "https://x-access-token:\${{ secrets.GITHUB_TOKEN }}@codeberg.org/\${{ github.repository }}.git" pages
`;

const HOSTING_PROVIDERS_MD = `# Deploying Glyphrig on Static Hosts

Because all site generation lives inside \`@glyphrig/cli\`, your bookmark repository needs **no \`package.json\` or framework boilerplate**.

## Cloudflare Pages

- **Build command:** \`npx --yes @glyphrig/cli@0 build --base /\`
- **Build output directory:** \`dist\`
- **Node version env var:** \`NODE_VERSION=22\`

## Netlify

- **Build command:** \`npx --yes @glyphrig/cli@0 build --base /\`
- **Publish directory:** \`dist\`
- **Environment variables:** \`NODE_VERSION=22\`

## Vercel

- **Build Command:** \`npx --yes @glyphrig/cli@0 build --base /\`
- **Output Directory:** \`dist\`
- **Install Command:** \`true\` *(skip install since there is no \`package.json\`)*

## Local Preview & Validation

\`\`\`bash
npx --yes @glyphrig/cli@0 validate
npx --yes @glyphrig/cli@0 dev
\`\`\`
`;

function buildConfigYaml(opts: {
  title: string;
  description: string;
  author: string;
  accent: string;
  quickAdd?: InitQuickAddOptions;
}): string {
  const quickAddObj = opts.quickAdd
    ? {
        enabled: opts.quickAdd.enabled,
        forge: opts.quickAdd.forge,
        ...(opts.quickAdd.instanceUrl ? { instanceUrl: opts.quickAdd.instanceUrl } : {}),
        owner: opts.quickAdd.owner,
        repo: opts.quickAdd.repo,
        branch: opts.quickAdd.branch || 'main',
        rootDir: 'bookmarks',
      }
    : {
        enabled: false,
        forge: 'github',
        owner: '',
        repo: '',
        branch: 'main',
        rootDir: 'bookmarks',
      };

  const doc = {
    site: {
      title: opts.title,
      description: opts.description,
      author: opts.author,
    },
    theme: {
      accent: opts.accent,
      defaultView: 'list',
    },
    enrichment: {
      enabled: true,
      fetchFavicons: true,
      fetchOgImage: true,
      autoTags: false,
      concurrency: 8,
      timeoutMs: 5000,
      ttlDays: 30,
    },
    pwa: {
      enabled: true,
      quickAdd: quickAddObj,
    },
  };

  return `# Glyphrig Public Bookmark Site Configuration
# Only data & config live in this repo; @glyphrig/cli builds Astro + Pagefind in CI.

${YAML.stringify(doc, { lineWidth: 0 })}`;
}

function buildRepoReadme(opts: { title: string; ci: InitCiProvider }): string {
  let deploySteps = '';
  switch (opts.ci) {
    case 'github':
      deploySteps = `1. Push this repository to GitHub (\`main\` branch).
2. Open **Settings -> Pages -> Build and deployment -> Source** and select **GitHub Actions**.
3. [\`deploy.yml\`](./.github/workflows/deploy.yml) builds and publishes your site automatically whenever \`bookmarks/**\` or \`glyphrig.config.yaml\` changes.`;
      break;
    case 'gitlab':
      deploySteps = `1. Push this repository to GitLab (\`main\` branch).
2. [\`.gitlab-ci.yml\`](./.gitlab-ci.yml) builds your site into \`public/\` and publishes it to **GitLab Pages**.`;
      break;
    case 'forgejo':
      deploySteps = `1. Push this repository to Codeberg / Forgejo (\`main\` branch).
2. [\`.forgejo/workflows/deploy.yml\`](./.forgejo/workflows/deploy.yml) builds \`./dist\` and publishes to the \`pages\` branch.`;
      break;
    case 'cloudflare':
      deploySteps = `1. Connect this repository in **Cloudflare Pages**.
2. Set build command to \`npx --yes @glyphrig/cli@0 build --base /\`, output directory to \`dist\`, and env \`NODE_VERSION=22\`.`;
      break;
    case 'netlify':
      deploySteps = `1. Connect this repository in **Netlify**.
2. Set build command to \`npx --yes @glyphrig/cli@0 build --base /\`, publish directory to \`dist\`, and env \`NODE_VERSION=22\`.`;
      break;
    case 'vercel':
      deploySteps = `1. Import this repository in **Vercel**.
2. Set Install Command to \`true\`, Build Command to \`npx --yes @glyphrig/cli@0 build --base /\`, and Output Directory to \`dist\`.`;
      break;
    case 'all':
      deploySteps = `1. **GitHub Pages:** enabled by default via [\`.github/workflows/deploy.yml\`](./.github/workflows/deploy.yml) (set Pages source to **GitHub Actions**).
2. **GitLab / Forgejo / Cloudflare / Netlify / Vercel:** see [\`ci-templates/\`](./ci-templates/).`;
      break;
    case 'none':
      deploySteps = `Build locally or in your custom pipeline with:

\`\`\`bash
npx --yes @glyphrig/cli@0 build
\`\`\``;
      break;
  }

  return `# ${opts.title}

A data-only bookmark directory managed by **[Glyphrig](https://github.com/Glyphrig/Glyphrig)** — two-way browser-to-Git bookmark sync & static directory generator.

## Structure

- \`bookmarks/**/README.md\` — Your synced bookmark folders in Markdown
- \`glyphrig.config.yaml\` — Site title, theme accent, enrichment, and optional PWA Quick Add

## Publishing

${deploySteps}

## Connecting the Browser Extension

1. Create a dedicated folder in Chrome or Firefox (for example \`Bookmarks Bar/Public Bookmarks\`).
2. Open **Glyphrig Settings**, configure this repository (\`bookmarks\` folder on \`main\`), authenticate via GitHub Device Flow or a scoped Personal Access Token, select your folder, and confirm the initial dry-run preview.

## Local Preview & Validation

\`\`\`bash
npx --yes @glyphrig/cli@0 validate
npx --yes @glyphrig/cli@0 dev
\`\`\`

---

Powered by **[Glyphrig](https://github.com/Glyphrig/Glyphrig)** (\`npx @glyphrig/cli@0 init\`).
`;
}

function buildRootBookmarksMd(title: string, examples: boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  if (!examples) {
    return `---
title: ${YAML.stringify(title).trim()}
order: 0
description: Curated public bookmarks.
---

Welcome to my public bookmark directory.
`;
  }
  return `---
title: ${YAML.stringify(title).trim()}
order: 0
description: Curated tools, documentation, and reading lists.
---

Welcome to my public bookmark garden! Browse folders in the sidebar, press \`/\` to search, or subscribe via RSS.

- [Glyphrig](https://github.com/Glyphrig/Glyphrig) — Two-way browser-to-Git bookmark sync & static directory generator \`#glyphrig\` \`#bookmarks\` <!-- glyphrig: added=${today} -->
- [Astro](https://astro.build) — The static site framework powering Glyphrig \`#web\` \`#ssg\` <!-- glyphrig: added=${today} -->
`;
}

export function buildScaffoldFiles(
  options: Omit<InitBookmarkRepoOptions, 'targetDir' | 'force'>,
): Map<string, string> {
  const ci: InitCiProvider = options.ci ?? 'github';
  if (!INIT_CI_PROVIDERS.includes(ci)) {
    throw new Error(
      `Unsupported CI provider "${ci}". Expected one of: ${INIT_CI_PROVIDERS.join(', ')}`,
    );
  }

  const title = options.title?.trim() || 'My Public Bookmarks';
  const description =
    options.description?.trim() || 'Curated links synced from my browsers via Glyphrig.';
  const author = options.author?.trim() ?? '';
  const accent = options.accent?.trim() || '#b45309';
  if (!/^#[0-9a-fA-F]{3,8}$/.test(accent)) {
    throw new Error(`Invalid accent color "${accent}". Expected hex like #b45309.`);
  }
  const examples = options.examples ?? true;

  const files = new Map<string, string>();
  files.set('.gitignore', GITIGNORE_CONTENT);
  files.set(
    'glyphrig.config.yaml',
    buildConfigYaml({
      title,
      description,
      author,
      accent,
      quickAdd: options.quickAdd,
    }),
  );
  files.set('README.md', buildRepoReadme({ title, ci }));
  files.set('bookmarks/README.md', buildRootBookmarksMd(title, examples));

  if (examples) {
    const today = new Date().toISOString().slice(0, 10);
    files.set(
      'bookmarks/dev/README.md',
      `---
title: Developer Tools
order: 0
description: Languages, docs, CLI utilities, and engineering references.
---

Everyday engineering references and tools worth keeping close at hand.

- [MDN Web Docs](https://developer.mozilla.org) — Authoritative reference for HTML, CSS, and Web APIs \`#docs\` \`#web\` <!-- glyphrig: added=${today} -->
- [The Rust Programming Language](https://doc.rust-lang.org/book/) — Official Rust book and language guide \`#rust\` \`#books\` <!-- glyphrig: added=${today} -->
`,
    );
    files.set(
      'bookmarks/dev/web/README.md',
      `---
title: Web & Extensions
order: 0
description: Static site tooling, WebExtensions, and search indexing.
---

- [WXT](https://wxt.dev) — Next-gen WebExtension framework for Chrome and Firefox \`#extensions\` \`#typescript\` <!-- glyphrig: added=${today} -->
- [Pagefind](https://pagefind.app) — Fully static, zero-backend search library \`#search\` \`#static\` <!-- glyphrig: added=${today} -->
`,
    );
    files.set(
      'bookmarks/reading/README.md',
      `---
title: Reading List
order: 1
description: Essays, digital gardens, and long-form articles.
---

- [Maggie Appleton — A Brief History & Ethos of the Digital Garden](https://maggieappleton.com/garden-history) — On evolving personal knowledge spaces \`#digital-garden\` \`#essays\` <!-- glyphrig: added=${today} -->
- [Gwern — About Gwern.net](https://gwern.net/about) — Notes on long-lived static publishing and link longevity \`#archival\` \`#web\` <!-- glyphrig: added=${today} -->
`,
    );
  }

  if (ci === 'github' || ci === 'all') {
    files.set('.github/workflows/deploy.yml', GITHUB_DEPLOY_WORKFLOW);
  }
  if (ci === 'gitlab') {
    files.set('.gitlab-ci.yml', GITLAB_CI_YAML);
  }
  if (ci === 'forgejo') {
    files.set('.forgejo/workflows/deploy.yml', FORGEJO_DEPLOY_WORKFLOW);
  }
  if (ci === 'all') {
    files.set('ci-templates/gitlab-ci.yml', GITLAB_CI_YAML);
    files.set('ci-templates/forgejo-deploy.yml', FORGEJO_DEPLOY_WORKFLOW);
    files.set('ci-templates/hosting-providers.md', HOSTING_PROVIDERS_MD);
  }

  return files;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function initBookmarkRepo(
  options: InitBookmarkRepoOptions,
): Promise<InitBookmarkRepoResult> {
  const targetDir = path.resolve(options.targetDir);
  const ci = options.ci ?? 'github';
  const force = options.force ?? false;
  const files = buildScaffoldFiles(options);

  await fs.mkdir(targetDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relPath, content] of files.entries()) {
    const absPath = path.join(targetDir, relPath);
    if (!force && (await fileExists(absPath))) {
      skipped.push(relPath);
      continue;
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
    created.push(relPath);
  }

  return { targetDir, ci, created, skipped };
}
