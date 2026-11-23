#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ForgeKind } from '@glyphrig/core';
import { Command } from 'commander';
import { buildSite, devSite } from './astro-runner.js';
import {
  INIT_CI_PROVIDERS,
  initBookmarkRepo,
  type InitCiProvider,
  type InitQuickAddOptions,
} from './init.js';
import { validateBookmarksRepo } from './loader.js';
import { BUILTIN_THEMES, ejectDefaultTheme, scaffoldTheme } from './theme.js';

const program = new Command();

program
  .name('glyphrig')
  .description('Scaffold, build, preview, and validate a static Glyphrig bookmark directory site.')
  .version('0.4.0');

async function promptInitOptions(
  dirArg: string,
  opts: {
    ci?: string;
    title?: string;
    description?: string;
    author?: string;
    accent?: string;
    examples?: boolean;
    quickAdd?: boolean;
    forge?: string;
    owner?: string;
    repo?: string;
  },
  cmd: Command,
) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = async (label: string, fallback: string): Promise<string> => {
    const suffix = fallback ? ` (${fallback})` : '';
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback;
  };

  const fromCli = (name: string): boolean => cmd.getOptionValueSource(name) === 'cli';

  try {
    const defaultTitle =
      opts.title ??
      (dirArg !== '.'
        ? path
            .basename(path.resolve(dirArg))
            .replace(/[-_]+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
        : 'My Public Bookmarks');

    const title = opts.title ?? (await ask('Site title', defaultTitle));
    const description =
      opts.description ??
      (await ask('Site description', 'Curated links synced from my browsers via Glyphrig.'));
    const author = opts.author ?? (await ask('Author name (optional)', ''));

    let ciRaw = opts.ci;
    if (!ciRaw) {
      ciRaw = await ask(
        `CI/hosting provider [${INIT_CI_PROVIDERS.join('/')}]`,
        'github',
      );
    }
    const ci = (INIT_CI_PROVIDERS.includes(ciRaw as InitCiProvider)
      ? ciRaw
      : 'github') as InitCiProvider;

    let examples = opts.examples ?? true;
    if (!fromCli('examples')) {
      const exAns = (await ask('Include starter example bookmarks? [Y/n]', 'Y')).toLowerCase();
      examples = !exAns.startsWith('n');
    }

    let quickAdd: InitQuickAddOptions | undefined;
    const enableQa = fromCli('quickAdd')
      ? Boolean(opts.quickAdd)
      : (await ask('Enable PWA Quick Add for mobile? [y/N]', 'N'))
          .toLowerCase()
          .startsWith('y');

    if (enableQa) {
      const forgeAns = fromCli('forge')
        ? (opts.forge ?? 'github')
        : await ask('Git forge [github/gitlab/forgejo]', 'github');
      const forge = (['github', 'gitlab', 'forgejo'].includes(forgeAns)
        ? forgeAns
        : 'github') as ForgeKind;
      const owner = opts.owner ?? (await ask('Repository owner / namespace', 'your-username'));
      const repo =
        opts.repo ??
        (await ask('Repository name', dirArg === '.' ? 'glyphrig_bookmarks' : path.basename(path.resolve(dirArg))));
      quickAdd = { enabled: true, forge, owner, repo };
    }

    return {
      title,
      description,
      author,
      ci,
      accent: opts.accent,
      examples,
      quickAdd,
    };
  } finally {
    rl.close();
  }
}

program
  .command('init')
  .argument('[dir]', 'Target directory for the bookmark repository', '.')
  .description('Initialize a new data-only Glyphrig bookmark repository')
  .option(
    '--ci <provider>',
    `CI/hosting template (${INIT_CI_PROVIDERS.join('|')})`,
  )
  .option('--title <title>', 'Site title')
  .option('--description <desc>', 'Site description')
  .option('--author <name>', 'Site author')
  .option('--accent <hex>', 'Theme accent hex color (default #b45309)')
  .option('--no-examples', 'Create empty root folder without sample bookmarks')
  .option('--quick-add', 'Enable PWA Quick Add in glyphrig.config.yaml')
  .option('--forge <forge>', 'Forge for Quick Add (github|gitlab|forgejo)', 'github')
  .option('--owner <owner>', 'Repository owner for Quick Add')
  .option('--repo <repo>', 'Repository name for Quick Add')
  .option('-f, --force', 'Overwrite existing files', false)
  .option('-y, --yes', 'Skip interactive prompts and use flags/defaults', false)
  .action(async (dir: string, opts, cmd: Command) => {
    const resolvedDir = path.resolve(dir);
    const interactive = Boolean(process.stdin.isTTY) && !opts.yes;

    let initInput;
    if (interactive) {
      initInput = await promptInitOptions(dir, opts, cmd);
    } else {
      const ci = (opts.ci ?? 'github') as InitCiProvider;
      const forge = (opts.forge ?? 'github') as ForgeKind;
      if (!['github', 'gitlab', 'forgejo'].includes(forge)) {
        throw new Error(`Invalid forge "${forge}". Expected github, gitlab, or forgejo.`);
      }
      initInput = {
        ci,
        title: opts.title,
        description: opts.description,
        author: opts.author,
        accent: opts.accent,
        examples: opts.examples !== false,
        quickAdd: opts.quickAdd
          ? {
              enabled: true,
              forge,
              owner: opts.owner || 'your-username',
              repo:
                opts.repo ||
                (dir === '.' ? 'glyphrig_bookmarks' : path.basename(resolvedDir)),
            }
          : undefined,
      };
    }

    const res = await initBookmarkRepo({
      targetDir: resolvedDir,
      ...initInput,
      force: Boolean(opts.force),
    });

    console.log(`Initialized Glyphrig bookmark repository in ${res.targetDir} (CI: ${res.ci})`);
    for (const file of res.created) {
      console.log(`  + ${file}`);
    }
    for (const file of res.skipped) {
      console.log(`  ~ skipped existing ${file}`);
    }

    let hasGit = false;
    try {
      await fs.access(path.join(res.targetDir, '.git'));
      hasGit = true;
    } catch {
      hasGit = false;
    }

    console.log('\nNext steps:');
    if (dir !== '.') {
      console.log(`  1. cd ${dir}`);
    }
    if (!hasGit) {
      console.log('  2. git init -b main && git add -A && git commit -m "chore: initial glyphrig bookmarks"');
      console.log('  3. Push to a new repository on your Git forge (e.g. `gh repo create --public --source=. --push`)');
    } else {
      console.log('  2. Review glyphrig.config.yaml & bookmarks/, then commit and push to main');
    }
    if (res.ci === 'github' || res.ci === 'all') {
      console.log('  4. On GitHub: Settings -> Pages -> Source -> GitHub Actions');
    }
    console.log('  5. Connect the Glyphrig browser extension to a dedicated bookmark folder.');
    console.log('  Tip: preview locally anytime with `npx --yes @glyphrig/cli@0 dev`');
  });

program
  .command('build')
  .description('Build the static Astro + Pagefind site from bookmarks/**/README.md')
  .option('-i, --input <dir>', 'Bookmarks root directory', 'bookmarks')
  .option('-c, --config <file>', 'Path to glyphrig.config.yaml')
  .option('-o, --out <dir>', 'Output directory', 'dist')
  .option('--cache-dir <dir>', 'Enrichment & Astro cache directory', '.glyphrig-cache')
  .option('--base <path>', 'Override URL base path (e.g. /my-repo/)')
  .option('--theme <spec>', 'Override theme (preset name, local folder/CSS path, or npm package)')
  .option('--no-enrich', 'Skip build-time URL metadata & favicon fetching')
  .action(async (opts) => {
    const result = await buildSite({
      inputDir: opts.input,
      configPath: opts.config,
      outDir: opts.out,
      cacheDir: opts.cacheDir,
      base: opts.base,
      theme: opts.theme,
      noEnrich: opts.enrich === false,
    });

    console.log(
      `Glyphrig built ${result.bookmarkCount} bookmarks across ${result.folderCount} folders (theme: ${result.themeName}) -> ${result.outDir}`,
    );
    console.log(
      `Enrichment: ${result.enrichStats.cacheHits} cached, ${result.enrichStats.fetchedOk} fetched, ${result.enrichStats.failed} failed, ${result.enrichStats.skippedUnsafe} skipped`,
    );
  });

program
  .command('dev')
  .description('Start a local development preview server')
  .option('-i, --input <dir>', 'Bookmarks root directory', 'bookmarks')
  .option('-c, --config <file>', 'Path to glyphrig.config.yaml')
  .option('--cache-dir <dir>', 'Enrichment & Astro cache directory', '.glyphrig-cache')
  .option('--base <path>', 'Override URL base path')
  .option('--theme <spec>', 'Override theme (preset name, local folder/CSS path, or npm package)')
  .option('-p, --port <number>', 'Port to listen on', '4321')
  .option('--no-enrich', 'Skip build-time URL metadata & favicon fetching')
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10) || 4321;
    const server = await devSite({
      inputDir: opts.input,
      configPath: opts.config,
      cacheDir: opts.cacheDir,
      base: opts.base,
      theme: opts.theme,
      port,
      noEnrich: opts.enrich === false,
    });
    console.log(`Glyphrig dev server running at http://localhost:${server.address.port}`);
  });

const themeCmd = program
  .command('theme')
  .description('List built-in themes or scaffold/eject a custom theme');

themeCmd
  .command('list')
  .description('List built-in theme presets')
  .action(() => {
    console.log('Built-in Glyphrig themes:\n');
    for (const preset of BUILTIN_THEMES) {
      console.log(
        `  ${preset.id.padEnd(11)} ${preset.name} (default: ${preset.defaultColorScheme}, accent: ${preset.defaultAccent})`,
      );
      console.log(`              ${preset.description}`);
    }
    console.log('\nUse any preset in glyphrig.config.yaml via `theme: { use: terminal }` or pass `--theme terminal`.');
  });

themeCmd
  .command('init [dir]')
  .description('Scaffold a custom CSS or Astro theme directory')
  .option('--type <css|astro>', 'Theme kind: css (default) or astro', 'css')
  .option('--mode <extend|replace>', 'For CSS themes: extend default CSS or replace it completely', 'extend')
  .option('--name <name>', 'Theme display name')
  .option('--force', 'Overwrite existing files in target directory')
  .action(async (dir = 'theme', opts) => {
    const type = String(opts.type).toLowerCase();
    if (type !== 'css' && type !== 'astro') {
      throw new Error(`Invalid --type "${opts.type}". Expected "css" or "astro".`);
    }
    const mode = String(opts.mode).toLowerCase();
    if (mode !== 'extend' && mode !== 'replace') {
      throw new Error(`Invalid --mode "${opts.mode}". Expected "extend" or "replace".`);
    }
    const res = await scaffoldTheme({
      targetDir: path.resolve(process.cwd(), dir),
      type,
      mode,
      name: opts.name,
      force: Boolean(opts.force),
    });
    console.log(`Scaffolded custom ${res.type} theme in ${res.targetDir}`);
    for (const file of res.created) {
      console.log(`  + ${file}`);
    }
    for (const file of res.skipped) {
      console.log(`  ~ skipped existing ${file}`);
    }
    const rel = dir.startsWith('.') || path.isAbsolute(dir) ? dir : `./${dir}`;
    console.log(`\nActivate it in glyphrig.config.yaml:\n\n  theme:\n    use: ${rel}\n`);
    console.log(`Or preview immediately:\n  npx --yes @glyphrig/cli@0 dev --theme ${rel}`);
  });

themeCmd
  .command('eject [dir]')
  .description('Copy the full default Astro theme into your repository for complete template control')
  .option('--name <name>', 'Theme display name')
  .option('--force', 'Overwrite existing files in target directory')
  .action(async (dir = 'theme', opts) => {
    const res = await ejectDefaultTheme({
      targetDir: path.resolve(process.cwd(), dir),
      name: opts.name,
      force: Boolean(opts.force),
    });
    console.log(`Ejected default Glyphrig Astro theme into ${res.targetDir}`);
    console.log(`  + ${res.created.length} file(s) written${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`);
    const rel = dir.startsWith('.') || path.isAbsolute(dir) ? dir : `./${dir}`;
    console.log(`\nActivate it in glyphrig.config.yaml:\n\n  theme:\n    use: ${rel}\n`);
    console.log(`Or preview immediately:\n  npx --yes @glyphrig/cli@0 dev --theme ${rel}`);
  });

program
  .command('validate')
  .description('Validate glyphrig.config.yaml and bookmarks/**/README.md files')
  .option('-i, --input <dir>', 'Bookmarks root directory', 'bookmarks')
  .option('-c, --config <file>', 'Path to glyphrig.config.yaml')
  .action(async (opts) => {
    const report = await validateBookmarksRepo({
      inputDir: opts.input,
      configPath: opts.config,
    });

    for (const w of report.warnings) {
      console.warn(`WARN: ${w}`);
    }
    for (const e of report.errors) {
      console.error(`ERROR: ${e}`);
    }
    console.log(
      `Validated ${report.bookmarkCount} bookmarks across ${report.folderCount} folders (${report.errors.length} errors, ${report.warnings.length} warnings).`,
    );
    if (!report.valid) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
