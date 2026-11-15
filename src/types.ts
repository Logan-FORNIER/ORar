export interface ArchiveEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  compressedSize: number;
  compressionMethod: string;
  crc32: number | null;
  modified: string | null;
  encrypted: boolean;
  deduplicated?: boolean;
}

export interface ArchiveInfo {
  archivePath: string;
  fileName: string;
  format: string;
  archiveFileSize: number;
  totalUncompressedSize: number;
  totalCompressedSize: number;
  fileCount: number;
  dirCount: number;
  comment: string | null;
  sha256Manifest: string | null;
  canExtract: boolean;
  canCreateFormat: boolean;
  isEncrypted: boolean;
  canMutate: boolean;
  deduplicatedFiles?: number;
  deduplicatedSavedBytes?: number;
  entries: ArchiveEntry[];
}

export interface CreateArchiveRequest {
  sourcePaths: string[];
  outputPath: string;
  format: string;
  compressionLevel: number;
  comment: string | null;
  password: string | null;
  encryptFilenames: boolean;
  splitSizeBytes: number | null;
  smartDevIgnore?: boolean;
  excludePatterns?: string[];
}

export interface ExtractArchiveRequest {
  archivePath: string;
  destinationDir: string;
  selectedEntries: string[] | null;
  password: string | null;
}

export interface ArchiveMutationRequest {
  archivePath: string;
  action: 'add' | 'delete' | 'rename' | 'mkdir' | 'write_text' | 'set_comment';
  targetDir?: string | null;
  sourcePaths?: string[] | null;
  paths?: string[] | null;
  oldPath?: string | null;
  newPath?: string | null;
  dirPath?: string | null;
  password?: string | null;
  textContent?: string | null;
  comment?: string | null;
}

export interface PreviewFileResponse {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  mimeType: string | null;
  textContent: string | null;
  base64Content: string | null;
  hexDump: string | null;
  size: number;
  truncated: boolean;
}

export interface IntegrityReport {
  archivePath: string;
  format: string;
  valid: boolean;
  checkedFiles: number;
  failedFiles: string[];
  manifestVerified: boolean | null;
  sha256Manifest: string | null;
  durationMs: number;
  message: string;
}

export interface EntryHashes {
  path: string;
  size: number;
  crc32Hex: string;
  md5Hex: string;
  sha1Hex: string;
  sha256Hex: string;
}

export interface ContentSearchMatch {
  path: string;
  lineNumber: number;
  linePreview: string;
  matchCount: number;
}

export interface ConvertArchiveRequest {
  sourceArchivePath: string;
  outputPath: string;
  targetFormat: string;
  compressionLevel: number;
  sourcePassword: string | null;
  targetPassword: string | null;
  encryptFilenames: boolean;
  comment: string | null;
}

export interface RepairReport {
  sourcePath: string;
  outputPath: string;
  format: string;
  recoveredFiles: number;
  damagedFiles: string[];
  message: string;
}

export interface SplitReport {
  sourcePath: string;
  parts: string[];
  totalSize: number;
  partSize: number;
  sha256: string;
}

export interface BenchmarkResult {
  engine: string;
  levelLabel: string;
  inputSize: number;
  compressedSize: number;
  ratioPercent: number;
  compressMbS: number;
  decompressMbS: number;
  compressMs: number;
  decompressMs: number;
}

export interface WindowsIntegrationStatus {
  orarAssociated: boolean;
  contextMenuEnabled: boolean;
  exePath: string;
}

export interface ArchiveDiffItem {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  leftSize: number | null;
  rightSize: number | null;
  sizeDelta: number;
  leftCrc32: number | null;
  rightCrc32: number | null;
}

export interface ArchiveDiffReport {
  leftPath: string;
  rightPath: string;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  unchangedCount: number;
  totalSizeDelta: number;
  items: ArchiveDiffItem[];
}

export interface BatchOperationRequest {
  mode: 'extract_each' | 'compress_each';
  sourcePaths: string[];
  destinationDir: string;
  format: string;
  compressionLevel: number;
  smartDevIgnore: boolean;
  password: string | null;
}

export interface BatchOperationReport {
  mode: string;
  processedCount: number;
  succeeded: string[];
  failed: string[];
  message: string;
}

export interface BackupProfile {
  id: string;
  name: string;
  sourcePaths: string[];
  destinationDir: string;
  format: string;
  compressionLevel: number;
  smartDevIgnore: boolean;
  password?: string;
}

export interface StegoCreateRequest {
  sourceArchivePath: string;
  coverPngPath: string | null;
  outputPngPath: string;
}

export interface StegoReport {
  stegoPngPath: string;
  extractedArchivePath: string | null;
  coverSize: number;
  payloadSize: number;
  totalSize: number;
  message: string;
}

export interface SfxReport {
  sourceArchivePath: string;
  sfxOutputPath: string;
  sfxSize: number;
  message: string;
}

export interface FsNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string | null;
  extension: string | null;
}

export interface QuickPlace {
  label: string;
  path: string;
}

export interface DirectoryListing {
  currentPath: string;
  parentPath: string | null;
  quickPlaces: QuickPlace[];
  items: FsNode[];
}

export interface ProgressPayload {
  operation: string;
  currentFile: string;
  processed: number;
  total: number;
  percent: number;
}

export type SortField = 'name' | 'size' | 'compressedSize' | 'ratio' | 'crc32' | 'modified';
export type SortDirection = 'asc' | 'desc';
export type FilterKind = 'all' | 'dirs' | 'code' | 'images' | 'other';
export type SidebarTab = 'archive' | 'pc';
export type ToolsTab =
  | 'search'
  | 'analytics'
  | 'diff'
  | 'convert'
  | 'volumes'
  | 'repair'
  | 'backup'
  | 'stego'
  | 'benchmark'
  | 'windows';

export interface RecentArchive {
  path: string;
  name: string;
  format: string;
  openedAt: string;
}

export interface FolderTreeNode {
  name: string;
  path: string;
  children: FolderTreeNode[];
  fileCount: number;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  tagName: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string | null;
  htmlUrl: string;
  installerUrl: string | null;
  installerName: string | null;
  installerSize: number | null;
}

export interface UpdateInstallReport {
  downloadedPath: string;
  launched: boolean;
  message: string;
}
