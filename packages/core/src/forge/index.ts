import { ForgejoAdapter } from './forgejo.js';
import { GitHubAdapter } from './github.js';
import { GitLabAdapter } from './gitlab.js';
import type { ForgeAdapter, ForgeAdapterConfig } from './types.js';

export function createForgeAdapter(config: ForgeAdapterConfig): ForgeAdapter {
  switch (config.forge) {
    case 'github':
      return new GitHubAdapter(config);
    case 'gitlab':
      return new GitLabAdapter(config);
    case 'forgejo':
      return new ForgejoAdapter(config);
  }
}

export * from './encoding.js';
export * from './forgejo.js';
export * from './github.js';
export * from './gitlab.js';
export * from './types.js';
