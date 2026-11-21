#!/usr/bin/env node
import { Command } from 'commander';
import { buildSite, devSite } from './astro-runner.js';
import { validateBookmarksRepo } from './loader.js';

const program = new Command();

program
  .name('glyphrig')
  .description('Build and validate a static Glyphrig bookmark directory site.')
  .version('0.1.0');

program
  .command('build')
  .description('Build the static Astro + Pagefind site from bookmarks/**/README.md')
  .option('-i, --input <dir>', 'Bookmarks root directory', 'bookmarks')
  .option('-c, --config <file>', 'Path to glyphrig.config.yaml')
  .option('-o, --out <dir>', 'Output directory', 'dist')
  .option('--cache-dir <dir>', 'Enrichment & Astro cache directory', '.glyphrig-cache')
  .option('--base <path>', 'Override URL base path (e.g. /my-repo/)')
  .option('--no-enrich', 'Skip build-time URL metadata & favicon fetching')
  .action(async (opts) => {
    const result = await buildSite({
      inputDir: opts.input,
      configPath: opts.config,
      outDir: opts.out,
      cacheDir: opts.cacheDir,
      base: opts.base,
      noEnrich: opts.enrich === false,
    });

    console.log(
      `Glyphrig built ${result.bookmarkCount} bookmarks across ${result.folderCount} folders -> ${result.outDir}`,
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
  .option('-p, --port <number>', 'Port to listen on', '4321')
  .option('--no-enrich', 'Skip build-time URL metadata & favicon fetching')
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10) || 4321;
    const server = await devSite({
      inputDir: opts.input,
      configPath: opts.config,
      cacheDir: opts.cacheDir,
      base: opts.base,
      port,
      noEnrich: opts.enrich === false,
    });
    console.log(`Glyphrig dev server running at http://localhost:${server.address.port}`);
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
