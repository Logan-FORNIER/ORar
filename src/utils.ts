import { ArchiveEntry, FilterKind, FolderTreeNode } from './types';

export const ARCHIVE_EXTENSIONS = [
  '.orar',
  '.zip',
  '.7z',
  '.rar',
  '.tar.gz',
  '.tgz',
  '.tar.zst',
  '.tzst',
  '.zst',
  '.tar.xz',
  '.txz',
  '.xz',
  '.tar',
];

const CODE_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'rs', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'htm',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'py', 'c', 'cpp', 'h',
  'hpp', 'cs', 'java', 'go', 'sh', 'ps1', 'bat', 'sql', 'csv', 'log', 'svg',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
]);

const MEDIA_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'aac', 'mp4', 'mkv', 'avi', 'mov', 'webm',
]);

const DOC_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf',
]);

export function isSupportedArchivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function getFileCategory(entry: ArchiveEntry): Exclude<FilterKind, 'all'> {
  if (entry.isDir) return 'dirs';
  const ext = getExtension(entry.name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'images';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'other';
}

export type DetailedCategory = 'Code & Texte' | 'Images' | 'Documents' | 'Audio & Vidéo' | 'Binaires & Autres';

export function getDetailedCategory(entry: ArchiveEntry): DetailedCategory {
  const ext = getExtension(entry.name);
  if (CODE_EXTENSIONS.has(ext)) return 'Code & Texte';
  if (IMAGE_EXTENSIONS.has(ext)) return 'Images';
  if (DOC_EXTENSIONS.has(ext)) return 'Documents';
  if (MEDIA_EXTENSIONS.has(ext)) return 'Audio & Vidéo';
  return 'Binaires & Autres';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let val = bytes;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx++;
  }
  const decimals = unitIdx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(decimals)} ${units[unitIdx]}`;
}

export function computeSavingPercent(original: number, compressed: number): number | null {
  if (original <= 0) return null;
  return Math.round(((original - compressed) / original) * 100);
}

export function formatCrc32(crc: number | null): string {
  if (crc === null || crc === undefined) return '—';
  return crc.toString(16).toUpperCase().padStart(8, '0');
}

export function getDirectChildren(entries: ArchiveEntry[], currentDir: string): ArchiveEntry[] {
  const prefix = currentDir ? `${currentDir}/` : '';
  return entries.filter((entry) => {
    if (!entry.path.startsWith(prefix)) return false;
    const rest = entry.path.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
  });
}

export function buildFolderTree(entries: ArchiveEntry[]): FolderTreeNode[] {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  const fileCounts = new Map<string, number>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const parent = slash === -1 ? '' : f.path.slice(0, slash);
    fileCounts.set(parent, (fileCounts.get(parent) ?? 0) + 1);
  }

  const nodeMap = new Map<string, FolderTreeNode>();
  const roots: FolderTreeNode[] = [];

  const sortedDirs = [...dirs].sort((a, b) => a.path.localeCompare(b.path));
  for (const dir of sortedDirs) {
    const node: FolderTreeNode = {
      name: dir.name,
      path: dir.path,
      children: [],
      fileCount: fileCounts.get(dir.path) ?? 0,
    };
    nodeMap.set(dir.path, node);

    const slash = dir.path.lastIndexOf('/');
    if (slash === -1) {
      roots.push(node);
    } else {
      const parentPath = dir.path.slice(0, slash);
      const parentNode = nodeMap.get(parentPath);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}

export function suggestOutputArchivePath(sourcePaths: string[], format: string): string {
  const ext = format.startsWith('.') ? format : `.${format}`;
  if (sourcePaths.length === 0) return `Archive${ext}`;

  const first = sourcePaths[0].replace(/[\\/]+$/, '');
  const sepIdx = Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/'));
  const parent = sepIdx >= 0 ? first.slice(0, sepIdx + 1) : '';
  const rawName = sepIdx >= 0 ? first.slice(sepIdx + 1) : first;

  const baseName =
    sourcePaths.length === 1
      ? rawName.replace(/\.[^.]+$/, '') || 'Archive'
      : 'Archive_ORar';

  return `${parent}${baseName}${ext}`;
}

export function replaceArchiveExtension(path: string, format: string): string {
  const ext = format.startsWith('.') ? format : `.${format}`;
  const lower = path.toLowerCase();
  for (const known of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(known)) {
      return `${path.slice(0, path.length - known.length)}${ext}`;
    }
  }
  return `${path}${ext}`;
}

export function parsePasswordError(err: unknown): string | null {
  const msg = String(err);
  if (msg.includes('PASSWORD_REQUIRED:')) {
    return msg.split('PASSWORD_REQUIRED:')[1]?.trim() || 'Mot de passe requis.';
  }
  return null;
}

export function measurePasswordStrength(pw: string): {
  label: string;
  color: string;
  percent: number;
} {
  if (!pw) return { label: 'Aucun', color: 'bg-slate-300', percent: 0 };
  let score = 0;
  if (pw.length >= 6) score += 25;
  if (pw.length >= 10) score += 25;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 20;
  if (/[0-9]/.test(pw)) score += 15;
  if (/[^A-Za-z0-9]/.test(pw)) score += 15;

  if (score < 40) return { label: 'Faible', color: 'bg-rose-500', percent: Math.max(25, score) };
  if (score < 75) return { label: 'Moyen', color: 'bg-amber-500', percent: score };
  return { label: 'Fort (AES-256)', color: 'bg-emerald-500', percent: 100 };
}
