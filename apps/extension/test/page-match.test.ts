import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_CONFIG, type ProfileConfig, type SyncSnapshot } from '@glyphrig/core';
import {
  collectSubfoldersFromSnapshot,
  collectTagsFromSnapshot,
  countUniqueCollaboratorsForUrl,
  findUrlMatchesAcrossProfiles,
} from '../src/lib/page-match.js';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'p1',
    name: 'Engineering Garden',
    enabled: true,
    forge: 'github',
    owner: 'tekromancy',
    repo: 'bookmarks',
    branch: 'main',
    rootDir: 'bookmarks',
    token: 'tok',
    rootFolderId: '10',
    autoSync: true,
    pushDebounceSeconds: 60,
    pullIntervalMinutes: 15,
    safety: { ...DEFAULT_SAFETY_CONFIG },
    ...overrides,
  };
}

describe('page-match local team awareness helpers', () => {
  const snapshot: SyncSnapshot = {
    lastSyncedCommitSha: 'abc123',
    lastSyncedAt: '2026-11-25T00:00:00Z',
    lastSyncedTree: {
      root: {
        path: '',
        slug: '',
        title: 'Engineering',
        order: 0,
        bookmarks: [],
        children: [
          {
            path: 'systems',
            slug: 'systems',
            title: 'Systems',
            order: 0,
            bookmarks: [
              {
                title: 'Zero-Copy Rust',
                url: 'https://example.com/zero-copy',
                normalizedUrl: 'https://example.com/zero-copy',
                note: 'Great explainer',
                contributorNotes: {
                  alice: 'Benchmark section is gold',
                  bob: 'Used in worker',
                },
                tags: ['rust', 'perf'],
                savedBy: ['alice', 'bob'],
                order: 0,
              },
              {
                title: 'Rust Book',
                url: 'https://doc.rust-lang.org/book/',
                normalizedUrl: 'https://doc.rust-lang.org/book',
                tags: ['rust', 'docs'],
                savedBy: ['alice'],
                order: 1,
              },
            ],
            children: [],
          },
        ],
      },
    },
  };

  it('finds URL matches across synced profiles and normalizes trailing slashes / fragments', () => {
    const matches = findUrlMatchesAcrossProfiles(
      'https://example.com/zero-copy/#section-2',
      [makeProfile()],
      { p1: snapshot },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      profileId: 'p1',
      folderPath: 'systems',
      folderTitle: 'Systems',
      savedBy: ['alice', 'bob'],
      contributorNotes: {
        alice: 'Benchmark section is gold',
        bob: 'Used in worker',
      },
    });
    expect(countUniqueCollaboratorsForUrl(matches)).toBe(2);
  });

  it('collects frequency-sorted tags and nested subfolders from snapshot', () => {
    expect(collectTagsFromSnapshot(snapshot)).toEqual(['rust', 'docs', 'perf']);
    expect(collectSubfoldersFromSnapshot(snapshot)).toEqual([
      { path: '', title: 'Engineering' },
      { path: 'systems', title: '↳ Systems' },
    ]);
  });

  it('prefers lastRemoteTree over lastSyncedTree for contribute-only / propose-pr profiles', () => {
    const contribSnap: SyncSnapshot = {
      lastSyncedCommitSha: 'def456',
      lastSyncedAt: '2026-11-25T00:00:00Z',
      lastSyncedTree: {
        root: {
          path: '',
          slug: '',
          title: 'My Local Folder',
          order: 0,
          bookmarks: [],
          children: [],
        },
      },
      lastRemoteTree: snapshot.lastSyncedTree,
    };

    const matches = findUrlMatchesAcrossProfiles(
      'https://example.com/zero-copy',
      [makeProfile({ syncMode: 'contribute-only' })],
      { p1: contribSnap },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.savedBy).toEqual(['alice', 'bob']);
    expect(collectTagsFromSnapshot(contribSnap)).toEqual(['rust', 'docs', 'perf']);
    expect(collectSubfoldersFromSnapshot(contribSnap)).toHaveLength(2);
  });
});
