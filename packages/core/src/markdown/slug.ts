export function slugifyFolderName(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'folder';
}

export function assignSiblingSlugs(titles: string[]): string[] {
  const counts = new Map<string, number>();
  return titles.map((title) => {
    const base = slugifyFolderName(title);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

export function normalizeRepoRootDir(rootDir: string): string {
  return rootDir.replace(/^\/+|\/+$/g, '') || 'bookmarks';
}

export const ARCHIVE_DIR_NAME = '.archived';

export function folderPathToFilePath(rootDir: string, folderPath: string): string {
  const root = normalizeRepoRootDir(rootDir);
  const cleanFolder = folderPath.replace(/^\/+|\/+$/g, '');
  return cleanFolder ? `${root}/${cleanFolder}/README.md` : `${root}/README.md`;
}

export function folderPathToArchiveFilePath(rootDir: string, folderPath: string): string {
  const root = normalizeRepoRootDir(rootDir);
  const cleanFolder = folderPath.replace(/^\/+|\/+$/g, '');
  return cleanFolder
    ? `${root}/${cleanFolder}/${ARCHIVE_DIR_NAME}/README.md`
    : `${root}/${ARCHIVE_DIR_NAME}/README.md`;
}

export function filePathToFolderPath(rootDir: string, filePath: string): string | null {
  const root = normalizeRepoRootDir(rootDir);
  const cleanPath = filePath.replace(/^\/+/, '');
  if (cleanPath === `${root}/README.md`) {
    return '';
  }
  const prefix = `${root}/`;
  const suffix = '/README.md';
  if (cleanPath.startsWith(prefix) && cleanPath.endsWith(suffix)) {
    const middle = cleanPath.slice(prefix.length, cleanPath.length - suffix.length);
    if (!middle || middle.split('/').some((seg) => !seg || seg.startsWith('.'))) {
      return null;
    }
    return middle;
  }
  return null;
}

export function archiveFilePathToFolderPath(rootDir: string, filePath: string): string | null {
  const root = normalizeRepoRootDir(rootDir);
  const cleanPath = filePath.replace(/^\/+/, '');
  const rootArchive = `${root}/${ARCHIVE_DIR_NAME}/README.md`;
  if (cleanPath === rootArchive) {
    return '';
  }
  const prefix = `${root}/`;
  const suffix = `/${ARCHIVE_DIR_NAME}/README.md`;
  if (cleanPath.startsWith(prefix) && cleanPath.endsWith(suffix)) {
    const middle = cleanPath.slice(prefix.length, cleanPath.length - suffix.length);
    if (!middle || middle.split('/').some((seg) => !seg || seg.startsWith('.'))) {
      return null;
    }
    return middle;
  }
  return null;
}

export function isBookmarkOrArchiveFilePath(rootDir: string, filePath: string): boolean {
  return (
    filePathToFolderPath(rootDir, filePath) !== null ||
    archiveFilePathToFolderPath(rootDir, filePath) !== null
  );
}
