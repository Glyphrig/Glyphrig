import fs from 'node:fs/promises';
import path from 'node:path';
import type { SiteConfig } from '@glyphrig/site';
import YAML from 'yaml';
import { z } from 'zod';

const QuickAddSchema = z.object({
  enabled: z.boolean().default(false),
  forge: z.enum(['github', 'gitlab', 'forgejo']).default('github'),
  instanceUrl: z.string().optional(),
  owner: z.string().default(''),
  repo: z.string().default(''),
  branch: z.string().default('main'),
  rootDir: z.string().default('bookmarks'),
});

const GlyphrigConfigSchema = z.object({
  site: z
    .object({
      title: z.string().min(1).default('Glyphrig Bookmarks'),
      description: z.string().default('Curated public bookmarks.'),
      author: z.string().default(''),
      url: z.string().optional(),
      base: z.string().optional(),
    })
    .default({
      title: 'Glyphrig Bookmarks',
      description: 'Curated public bookmarks.',
      author: '',
    }),
  theme: z
    .object({
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/, 'theme.accent must be a hex color like #b45309')
        .default('#b45309'),
      defaultView: z.enum(['list', 'cards']).default('list'),
      customCss: z.string().optional(),
    })
    .default({
      accent: '#b45309',
      defaultView: 'list',
    }),
  enrichment: z
    .object({
      enabled: z.boolean().default(true),
      fetchFavicons: z.boolean().default(true),
      fetchOgImage: z.boolean().default(true),
      autoTags: z.boolean().default(false),
      concurrency: z.number().int().min(1).max(32).default(8),
      timeoutMs: z.number().int().min(500).max(30000).default(5000),
      ttlDays: z.number().int().min(1).max(365).default(30),
    })
    .default({
      enabled: true,
      fetchFavicons: true,
      fetchOgImage: true,
      autoTags: false,
      concurrency: 8,
      timeoutMs: 5000,
      ttlDays: 30,
    }),
  pwa: z
    .object({
      enabled: z.boolean().default(true),
      quickAdd: QuickAddSchema.default({
        enabled: false,
        forge: 'github',
        owner: '',
        repo: '',
        branch: 'main',
        rootDir: 'bookmarks',
      }),
    })
    .default({
      enabled: true,
      quickAdd: {
        enabled: false,
        forge: 'github',
        owner: '',
        repo: '',
        branch: 'main',
        rootDir: 'bookmarks',
      },
    }),
});

export function normalizeSiteBase(rawBase?: string): string {
  const trimmed = (rawBase ?? '/').trim() || '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export async function inferBasePath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY) {
    // Respect custom domain CNAME if present in repo root
    try {
      await fs.access(path.join(cwd, 'CNAME'));
      return '/';
    } catch {
      // No CNAME file
    }

    const parts = env.GITHUB_REPOSITORY.split('/');
    if (parts.length === 2) {
      const [owner, repo] = parts as [string, string];
      if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
        return '/';
      }
      return normalizeSiteBase(`/${repo}/`);
    }
  }
  return '/';
}

export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  cliBase?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadGlyphrigConfig(
  options: LoadConfigOptions = {},
): Promise<{ config: SiteConfig; configFound: boolean; resolvedPath?: string }> {
  const cwd = options.cwd ?? process.cwd();
  const candidates = options.configPath
    ? [path.resolve(cwd, options.configPath)]
    : [
        path.join(cwd, 'glyphrig.config.yaml'),
        path.join(cwd, 'glyphrig.config.yml'),
        path.join(cwd, 'glyphrig.config.json'),
      ];

  let foundPath: string | undefined;
  let rawObj: Record<string, unknown> = {};

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf8');
      foundPath = candidate;
      const parsed = candidate.endsWith('.json')
        ? JSON.parse(content)
        : YAML.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawObj = parsed as Record<string, unknown>;
      } else if (parsed !== null && parsed !== undefined) {
        throw new Error(`Configuration in ${candidate} must be a YAML/JSON object.`);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        if (options.configPath) {
          throw new Error(`Config file not found: ${candidate}`);
        }
        continue;
      }
      throw err;
    }
  }

  const result = GlyphrigConfigSchema.safeParse(rawObj);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid glyphrig config: ${details}`);
  }

  const parsed = result.data;
  const resolvedBase = options.cliBase
    ? normalizeSiteBase(options.cliBase)
    : parsed.site.base
      ? normalizeSiteBase(parsed.site.base)
      : await inferBasePath(cwd, options.env);

  const config: SiteConfig = {
    site: {
      title: parsed.site.title,
      description: parsed.site.description,
      author: parsed.site.author,
      ...(parsed.site.url ? { url: parsed.site.url } : {}),
      base: resolvedBase,
    },
    theme: {
      accent: parsed.theme.accent,
      defaultView: parsed.theme.defaultView,
      ...(parsed.theme.customCss ? { customCss: parsed.theme.customCss } : {}),
    },
    enrichment: parsed.enrichment,
    pwa: parsed.pwa,
  };

  return {
    config,
    configFound: Boolean(foundPath),
    ...(foundPath ? { resolvedPath: foundPath } : {}),
  };
}
