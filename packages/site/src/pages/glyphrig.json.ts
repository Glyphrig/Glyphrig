import { getEffectiveCollaborationConfig, siteData, toAbsoluteUrl } from '../lib/data.js';

export function GET() {
  const collab = getEffectiveCollaborationConfig();
  const resolvedSiteUrl = siteData.config.site.url ? toAbsoluteUrl('') : undefined;

  const payload: Record<string, unknown> = {
    version: 1,
    title: siteData.config.site.title,
    description: siteData.config.site.description,
    ...(resolvedSiteUrl ? { siteUrl: resolvedSiteUrl } : {}),
    bookmarkCount: siteData.allBookmarks.length,
    folderCount: siteData.flatFolders.length + 1,
    contributorCount: siteData.contributors.length,
    generatedAt: siteData.generatedAt,
    ...(collab
      ? {
          forge: collab.forge,
          ...(collab.instanceUrl ? { instanceUrl: collab.instanceUrl } : {}),
          owner: collab.owner,
          repo: collab.repo,
          branch: collab.branch,
          rootDir: collab.rootDir,
          recommendedSyncMode: collab.recommendedSyncMode ?? 'subscribe-only',
        }
      : {}),
  };

  return new Response(JSON.stringify(payload, null, 2) + '\n', {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
