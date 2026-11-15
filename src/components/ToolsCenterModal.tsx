import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  Archive,
  ArrowRightLeft,
  CheckCircle2,
  EyeOff,
  FolderSearch,
  Gauge,
  GitCompare,
  HardDriveDownload,
  Image as ImageIcon,
  Layers,
  Loader2,
  Lock,
  MonitorCog,
  PackageCheck,
  PieChart,
  Play,
  Plus,
  Scissors,
  Search,
  Shield,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import {
  ArchiveDiffReport,
  ArchiveEntry,
  ArchiveInfo,
  BackupProfile,
  BatchOperationReport,
  BenchmarkResult,
  ContentSearchMatch,
  ConvertArchiveRequest,
  CreateArchiveRequest,
  RepairReport,
  SfxReport,
  SplitReport,
  StegoReport,
  ToolsTab,
  WindowsIntegrationStatus,
} from '../types';
import {
  computeSavingPercent,
  DetailedCategory,
  formatBytes,
  getDetailedCategory,
  isSupportedArchivePath,
  replaceArchiveExtension,
} from '../utils';

interface ToolsCenterModalProps {
  isOpen: boolean;
  initialTab: ToolsTab;
  archive: ArchiveInfo | null;
  sessionPassword: string | null;
  onClose: () => void;
  onOpenArchive: (path: string) => Promise<void>;
  onJumpToEntry: (entryPath: string) => void;
  onArchiveCreatedOrConverted: (info: ArchiveInfo) => void;
  onRequestPassword: (reason: string, onSuccess: (pw: string) => void) => void;
  onNotify: (kind: 'ok' | 'err', text: string) => void;
}

const BACKUP_PROFILES_KEY = 'orar:backup-profiles';

const DEFAULT_BACKUP_PROFILES: BackupProfile[] = [
  {
    id: 'default-dev-projects',
    name: 'Projets ORar & SoftMath',
    sourcePaths: ['E:\\ORar', 'E:\\SoftMath'],
    destinationDir: 'E:\\Archives_Backups',
    format: 'orar',
    compressionLevel: 6,
    smartDevIgnore: true,
  },
];

function loadBackupProfiles(): BackupProfile[] {
  try {
    const raw = localStorage.getItem(BACKUP_PROFILES_KEY);
    if (!raw) return DEFAULT_BACKUP_PROFILES;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_BACKUP_PROFILES;
  } catch {
    return DEFAULT_BACKUP_PROFILES;
  }
}

const TABS: { id: ToolsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'search', label: 'Plein texte', icon: <Search className="h-3.5 w-3.5" /> },
  { id: 'analytics', label: 'Analyseur', icon: <PieChart className="h-3.5 w-3.5" /> },
  { id: 'diff', label: 'Comparer', icon: <GitCompare className="h-3.5 w-3.5" /> },
  { id: 'convert', label: 'Convertir', icon: <ArrowRightLeft className="h-3.5 w-3.5" /> },
  { id: 'volumes', label: 'Volumes .part', icon: <Scissors className="h-3.5 w-3.5" /> },
  { id: 'repair', label: 'Réparer', icon: <Wrench className="h-3.5 w-3.5" /> },
  { id: 'backup', label: 'Backup & Lots', icon: <HardDriveDownload className="h-3.5 w-3.5" /> },
  { id: 'stego', label: 'Stego & SFX', icon: <Shield className="h-3.5 w-3.5" /> },
  { id: 'benchmark', label: 'Benchmark', icon: <Gauge className="h-3.5 w-3.5" /> },
  { id: 'windows', label: 'Windows', icon: <MonitorCog className="h-3.5 w-3.5" /> },
];

export function ToolsCenterModal({
  isOpen,
  initialTab,
  archive,
  sessionPassword,
  onClose,
  onOpenArchive,
  onJumpToEntry,
  onArchiveCreatedOrConverted,
  onRequestPassword,
  onNotify,
}: ToolsCenterModalProps) {
  const [tab, setTab] = useState<ToolsTab>(initialTab);

  // Full-text search state
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState<ContentSearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Convert state
  const [convertFormat, setConvertFormat] = useState('orar');
  const [convertLevel, setConvertLevel] = useState(6);
  const [convertOutput, setConvertOutput] = useState('');
  const [convertPassword, setConvertPassword] = useState('');
  const [convertEncryptNames, setConvertEncryptNames] = useState(false);
  const [convertLoading, setConvertLoading] = useState(false);

  // Split / Join state
  const [splitTargetPath, setSplitTargetPath] = useState('');
  const [splitSizeMb, setSplitSizeMb] = useState(25);
  const [splitReport, setSplitReport] = useState<SplitReport | null>(null);
  const [splitLoading, setSplitLoading] = useState(false);
  const [joinFirstPart, setJoinFirstPart] = useState('');
  const [joinedPath, setJoinedPath] = useState<string | null>(null);

  // Repair state
  const [repairPath, setRepairPath] = useState('');
  const [repairReport, setRepairReport] = useState<RepairReport | null>(null);
  const [repairLoading, setRepairLoading] = useState(false);

  // Benchmark state
  const [benchResults, setBenchResults] = useState<BenchmarkResult[]>([]);
  const [benchLoading, setBenchLoading] = useState(false);

  // Windows integration state
  const [winStatus, setWinStatus] = useState<WindowsIntegrationStatus | null>(null);
  const [assocOrar, setAssocOrar] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(false);
  const [winSaving, setWinSaving] = useState(false);

  // Archive Diff state
  const [diffLeftPath, setDiffLeftPath] = useState('');
  const [diffRightPath, setDiffRightPath] = useState('');
  const [diffFilter, setDiffFilter] = useState<'all' | 'modified' | 'added' | 'removed'>('all');
  const [diffReport, setDiffReport] = useState<ArchiveDiffReport | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Backup Profiles & Batch state
  const [backupProfiles, setBackupProfiles] = useState<BackupProfile[]>(loadBackupProfiles);
  const [profileRunningId, setProfileRunningId] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileSources, setNewProfileSources] = useState<string[]>([]);
  const [newProfileDest, setNewProfileDest] = useState('E:\\Archives_Backups');
  const [newProfileFormat, setNewProfileFormat] = useState('orar');
  const [newProfileIgnore, setNewProfileIgnore] = useState(true);
  const [newProfilePassword, setNewProfilePassword] = useState('');

  const [batchMode, setBatchMode] = useState<'compress_each' | 'extract_each'>('compress_each');
  const [batchSources, setBatchSources] = useState<string[]>([]);
  const [batchDestDir, setBatchDestDir] = useState('');
  const [batchFormat, setBatchFormat] = useState('orar');
  const [batchSmartIgnore, setBatchSmartIgnore] = useState(true);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchReport, setBatchReport] = useState<BatchOperationReport | null>(null);

  // Stego-ORar & SFX state
  const [stegoSourceArchive, setStegoSourceArchive] = useState('');
  const [stegoCoverPng, setStegoCoverPng] = useState('');
  const [stegoOutputPng, setStegoOutputPng] = useState('');
  const [stegoRevealPng, setStegoRevealPng] = useState('');
  const [stegoLoading, setStegoLoading] = useState(false);
  const [stegoReport, setStegoReport] = useState<StegoReport | null>(null);

  const [sfxSourceArchive, setSfxSourceArchive] = useState('');
  const [sfxOutputPath, setSfxOutputPath] = useState('');
  const [sfxLoading, setSfxLoading] = useState(false);
  const [sfxReport, setSfxReport] = useState<SfxReport | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab);
    if (archive) {
      setConvertOutput(replaceArchiveExtension(archive.archivePath, convertFormat));
      setSplitTargetPath(archive.archivePath);
      setRepairPath(archive.archivePath);
      setDiffLeftPath((prev) => prev || archive.archivePath);
      setStegoSourceArchive(archive.archivePath);
      const base = archive.archivePath.replace(/\.[^.]+$/, '');
      setStegoOutputPng(`${base}_stego.png`);
      setSfxSourceArchive(archive.archivePath);
      setSfxOutputPath(`${base}_SFX.cmd`);
    }
    invoke<WindowsIntegrationStatus>('get_windows_integration_status')
      .then((status) => {
        setWinStatus(status);
        setAssocOrar(status.orarAssociated);
        setCtxMenu(status.contextMenuEnabled);
      })
      .catch(() => {});
  }, [isOpen, initialTab, archive, convertFormat]);

  const analytics = useMemo(() => {
    if (!archive) return null;
    const files = archive.entries.filter((e) => !e.isDir);
    const categories = new Map<DetailedCategory, { count: number; size: number }>();
    const folderSizes = new Map<string, { count: number; size: number }>();

    for (const file of files) {
      const cat = getDetailedCategory(file);
      const prev = categories.get(cat) ?? { count: 0, size: 0 };
      categories.set(cat, { count: prev.count + 1, size: prev.size + file.size });

      const slash = file.path.indexOf('/');
      const topFolder = slash === -1 ? '(Racine)' : file.path.slice(0, slash);
      const prevFolder = folderSizes.get(topFolder) ?? { count: 0, size: 0 };
      folderSizes.set(topFolder, { count: prevFolder.count + 1, size: prevFolder.size + file.size });
    }

    const catList = Array.from(categories.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        size: data.size,
        share:
          archive.totalUncompressedSize > 0
            ? Math.round((data.size / archive.totalUncompressedSize) * 100)
            : 0,
      }))
      .sort((a, b) => b.size - a.size);

    const folderList = Array.from(folderSizes.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        size: data.size,
        share:
          archive.totalUncompressedSize > 0
            ? Math.max(1, Math.round((data.size / archive.totalUncompressedSize) * 100))
            : 0,
      }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 8);

    const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 8);
    const bestCompressed: { entry: ArchiveEntry; saving: number }[] = files
      .map((entry) => ({
        entry,
        saving: computeSavingPercent(entry.size, entry.compressedSize) ?? 0,
      }))
      .filter((x) => x.entry.size > 0 && x.saving > 0)
      .sort((a, b) => b.saving - a.saving)
      .slice(0, 6);

    return { catList, folderList, largest, bestCompressed, fileCount: files.length };
  }, [archive]);

  if (!isOpen) return null;

  const runContentSearch = async (pwOverride?: string) => {
    if (!archive || !searchText.trim()) return;
    setSearchLoading(true);
    setHasSearched(true);
    try {
      const hits = await invoke<ContentSearchMatch[]>('search_in_archive_contents', {
        archivePath: archive.archivePath,
        query: searchText,
        caseSensitive,
        password: pwOverride ?? sessionPassword,
      });
      setSearchResults(hits);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('PASSWORD_REQUIRED:')) {
        onRequestPassword(msg.split('PASSWORD_REQUIRED:')[1], (pw) => runContentSearch(pw));
      } else {
        onNotify('err', msg);
      }
    } finally {
      setSearchLoading(false);
    }
  };

  const runConvert = async () => {
    if (!archive || !convertOutput.trim()) return;
    setConvertLoading(true);
    try {
      const req: ConvertArchiveRequest = {
        sourceArchivePath: archive.archivePath,
        outputPath: convertOutput.trim(),
        targetFormat: convertFormat,
        compressionLevel: convertLevel,
        sourcePassword: sessionPassword,
        targetPassword:
          convertFormat === 'orar' && convertPassword.trim() ? convertPassword.trim() : null,
        encryptFilenames:
          convertFormat === 'orar' && Boolean(convertPassword.trim()) && convertEncryptNames,
        comment: `Converti depuis ${archive.fileName} par ORar`,
      };
      const nextInfo = await invoke<ArchiveInfo>('convert_archive_format', { req });
      onNotify('ok', `Converti avec succès : ${nextInfo.fileName}`);
      onArchiveCreatedOrConverted(nextInfo);
      onClose();
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setConvertLoading(false);
    }
  };

  const runSplit = async () => {
    if (!splitTargetPath.trim()) return;
    setSplitLoading(true);
    setSplitReport(null);
    try {
      const bytes = Math.max(1, splitSizeMb) * 1024 * 1024;
      const report = await invoke<SplitReport>('split_archive', {
        archivePath: splitTargetPath.trim(),
        volumeSizeBytes: bytes,
      });
      setSplitReport(report);
      onNotify('ok', `${report.parts.length} volume(s) créé(s).`);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setSplitLoading(false);
    }
  };

  const runJoin = async () => {
    if (!joinFirstPart.trim()) return;
    setSplitLoading(true);
    setJoinedPath(null);
    try {
      const outPath = await invoke<string>('join_split_archive', {
        firstPartPath: joinFirstPart.trim(),
        outputPath: null,
      });
      setJoinedPath(outPath);
      onNotify('ok', `Archive reconstituée : ${outPath}`);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setSplitLoading(false);
    }
  };

  const runRepair = async () => {
    if (!repairPath.trim()) return;
    setRepairLoading(true);
    setRepairReport(null);
    try {
      const report = await invoke<RepairReport>('repair_archive', {
        archivePath: repairPath.trim(),
        password: sessionPassword,
      });
      setRepairReport(report);
      onNotify('ok', report.message);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setRepairLoading(false);
    }
  };

  const runBenchmark = async () => {
    setBenchLoading(true);
    try {
      const res = await invoke<BenchmarkResult[]>('run_compression_benchmark');
      setBenchResults(res);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setBenchLoading(false);
    }
  };

  const saveWindowsIntegration = async () => {
    setWinSaving(true);
    try {
      const status = await invoke<WindowsIntegrationStatus>('set_windows_integration', {
        associateOrar: assocOrar,
        contextMenu: ctxMenu,
      });
      setWinStatus(status);
      onNotify('ok', 'Intégration Windows mise à jour dans HKCU.');
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setWinSaving(false);
    }
  };

  const maxSpeed = benchResults.reduce(
    (acc, r) => Math.max(acc, r.compressMbS, r.decompressMbS),
    1
  );

  const persistBackupProfiles = (next: BackupProfile[]) => {
    setBackupProfiles(next);
    try {
      localStorage.setItem(BACKUP_PROFILES_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage error
    }
  };

  const runDiff = async () => {
    if (!diffLeftPath.trim() || !diffRightPath.trim()) return;
    setDiffLoading(true);
    try {
      const rep = await invoke<ArchiveDiffReport>('compare_archives', {
        leftPath: diffLeftPath.trim(),
        rightPath: diffRightPath.trim(),
        leftPassword: sessionPassword,
        rightPassword: null,
      });
      setDiffReport(rep);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setDiffLoading(false);
    }
  };

  const runBackupProfile = async (profile: BackupProfile) => {
    setProfileRunningId(profile.id);
    try {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}h${String(
        now.getMinutes()
      ).padStart(2, '0')}`;
      const slug =
        profile.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '') || 'backup';
      const sep = profile.destinationDir.endsWith('\\') || profile.destinationDir.endsWith('/') ? '' : '\\';
      const outPath = `${profile.destinationDir}${sep}${slug}_${stamp}.${profile.format}`;

      const req: CreateArchiveRequest = {
        sourcePaths: profile.sourcePaths,
        outputPath: outPath,
        format: profile.format,
        compressionLevel: profile.compressionLevel,
        comment: `Sauvegarde automatique ORar : ${profile.name} (${now.toLocaleString('fr-FR')})`,
        password: profile.format === 'orar' && profile.password?.trim() ? profile.password.trim() : null,
        encryptFilenames: Boolean(profile.format === 'orar' && profile.password?.trim()),
        splitSizeBytes: null,
        smartDevIgnore: profile.smartDevIgnore,
        excludePatterns: [],
      };
      const info = await invoke<ArchiveInfo>('create_archive', { req });
      onNotify('ok', `Sauvegarde créée : ${info.fileName} (${formatBytes(info.archiveFileSize)})`);
      onArchiveCreatedOrConverted(info);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setProfileRunningId(null);
    }
  };

  const handleAddBackupProfile = () => {
    if (!newProfileName.trim() || newProfileSources.length === 0 || !newProfileDest.trim()) return;
    const created: BackupProfile = {
      id: `prof-${Date.now()}`,
      name: newProfileName.trim(),
      sourcePaths: newProfileSources,
      destinationDir: newProfileDest.trim(),
      format: newProfileFormat,
      compressionLevel: 6,
      smartDevIgnore: newProfileIgnore,
      password: newProfilePassword.trim() ? newProfilePassword.trim() : undefined,
    };
    persistBackupProfiles([created, ...backupProfiles]);
    setNewProfileName('');
    setNewProfileSources([]);
    setNewProfilePassword('');
    onNotify('ok', `Profil « ${created.name} » enregistré.`);
  };

  const runBatch = async () => {
    if (batchSources.length === 0 || !batchDestDir.trim()) return;
    setBatchLoading(true);
    setBatchReport(null);
    try {
      const rep = await invoke<BatchOperationReport>('run_batch_operation', {
        req: {
          mode: batchMode,
          sourcePaths: batchSources,
          destinationDir: batchDestDir.trim(),
          format: batchFormat,
          compressionLevel: 6,
          smartDevIgnore: batchSmartIgnore,
          password: sessionPassword,
        },
      });
      setBatchReport(rep);
      onNotify(rep.failed.length === 0 ? 'ok' : 'err', rep.message);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setBatchLoading(false);
    }
  };

  const runCreateStego = async () => {
    if (!stegoSourceArchive.trim() || !stegoOutputPng.trim()) return;
    setStegoLoading(true);
    setStegoReport(null);
    try {
      const rep = await invoke<StegoReport>('create_stego_archive', {
        req: {
          sourceArchivePath: stegoSourceArchive.trim(),
          coverPngPath: stegoCoverPng.trim() ? stegoCoverPng.trim() : null,
          outputPngPath: stegoOutputPng.trim(),
        },
      });
      setStegoReport(rep);
      onNotify('ok', rep.message);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setStegoLoading(false);
    }
  };

  const runRevealStego = async () => {
    if (!stegoRevealPng.trim()) return;
    setStegoLoading(true);
    setStegoReport(null);
    try {
      const [rep, info] = await invoke<[StegoReport, ArchiveInfo]>('extract_stego_archive', {
        stegoPngPath: stegoRevealPng.trim(),
        outputOrarPath: null,
        password: sessionPassword,
      });
      setStegoReport(rep);
      onNotify('ok', rep.message);
      onArchiveCreatedOrConverted(info);
      onClose();
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setStegoLoading(false);
    }
  };

  const runCreateSfx = async () => {
    if (!sfxSourceArchive.trim()) return;
    setSfxLoading(true);
    setSfxReport(null);
    try {
      const rep = await invoke<SfxReport>('create_sfx_bundle', {
        archivePath: sfxSourceArchive.trim(),
        outputSfxPath: sfxOutputPath.trim() ? sfxOutputPath.trim() : null,
        password: sessionPassword,
      });
      setSfxReport(rep);
      onNotify('ok', rep.message);
    } catch (err) {
      onNotify('err', String(err));
    } finally {
      setSfxLoading(false);
    }
  };

  const diffItemsFiltered = (diffReport?.items ?? []).filter((item) =>
    diffFilter === 'all' ? true : item.status === diffFilter
  );

  const treemapColors = [
    'from-amber-500 to-orange-500',
    'from-indigo-500 to-violet-500',
    'from-emerald-500 to-teal-500',
    'from-sky-500 to-cyan-500',
    'from-rose-500 to-pink-500',
    'from-slate-500 to-slate-600',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-xs">
      <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Studio d'Outils Pro ORar
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Plein texte • Analyseur Visuel • Diff • Convertisseur • Volumes • Réparation • Backup & Lots • Stego & SFX • Benchmark
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50/70 px-4 py-2 dark:border-slate-800 dark:bg-slate-950/40">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                tab === t.id
                  ? 'bg-slate-900 text-white shadow-xs dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 text-xs">
          {/* 1. Full-Text Search */}
          {tab === 'search' && (
            <div className="space-y-4">
              {!archive ? (
                <EmptyArchiveHint text="Ouvrez une archive pour rechercher du texte à l'intérieur de ses fichiers." />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') runContentSearch();
                        }}
                        placeholder="Rechercher une chaîne dans le contenu des fichiers (ex: token, fonction, TODO)..."
                        className="w-full rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-9 text-xs outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950"
                      />
                    </div>
                    <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700">
                      <input
                        type="checkbox"
                        checked={caseSensitive}
                        onChange={(e) => setCaseSensitive(e.target.checked)}
                        className="accent-amber-500"
                      />
                      <span>Sensible à la casse</span>
                    </label>
                    <button
                      type="button"
                      disabled={searchLoading || !searchText.trim()}
                      onClick={() => runContentSearch()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                    >
                      {searchLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Rechercher
                    </button>
                  </div>

                  {hasSearched && (
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        {searchResults.length} correspondance(s) trouvée(s)
                      </div>
                      {searchResults.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-slate-500 dark:border-slate-800">
                          Aucune occurrence trouvée dans les fichiers texte de l'archive.
                        </div>
                      ) : (
                        <div className="max-h-[44vh] space-y-1.5 overflow-y-auto">
                          {searchResults.map((hit, idx) => (
                            <button
                              key={`${hit.path}:${hit.lineNumber}:${idx}`}
                              type="button"
                              onClick={() => {
                                onJumpToEntry(hit.path);
                                onClose();
                              }}
                              className="flex w-full flex-col rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-left hover:border-amber-400 hover:bg-amber-500/5 dark:border-slate-800 dark:bg-slate-950/60"
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                                  {hit.path}
                                </span>
                                <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] dark:bg-slate-800">
                                  Ligne {hit.lineNumber}
                                </span>
                              </div>
                              <div className="mt-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
                                {hit.linePreview}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 2. Storage Analytics + Visual Treemap + Dedup Savings */}
          {tab === 'analytics' && (
            <div>
              {!archive || !analytics ? (
                <EmptyArchiveHint text="Ouvrez une archive pour visualiser sa répartition de stockage, son treemap et ses gains de déduplication." />
              ) : (
                <div className="space-y-4">
                  {(archive.deduplicatedFiles ?? 0) > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                      <div className="flex items-center gap-2.5">
                        <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                        <div>
                          <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                            Déduplication ORar active ({archive.deduplicatedFiles} doublon(s) lié(s))
                          </div>
                          <div className="text-[11px] text-emerald-700 dark:text-emerald-300/80">
                            Les fichiers identiques ne sont stockés physiquement qu’une seule fois dans l’archive.
                          </div>
                        </div>
                      </div>
                      <span className="rounded-xl bg-emerald-600 px-3 py-1 font-mono font-bold text-white">
                        +{formatBytes(archive.deduplicatedSavedBytes ?? 0)} économisés
                      </span>
                    </div>
                  )}

                  {/* Proportional Visual Treemap Bar & Folder Tiles */}
                  <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                    <h3 className="mb-2.5 font-semibold text-slate-800 dark:text-slate-100">
                      Carte visuelle d'espace par dossier & extension
                    </h3>
                    <div className="flex h-6 w-full overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800">
                      {analytics.catList.map((cat, idx) => (
                        <div
                          key={cat.name}
                          className={`bg-gradient-to-r ${treemapColors[idx % treemapColors.length]} transition-all`}
                          style={{ width: `${Math.max(2, cat.share)}%` }}
                          title={`${cat.name}: ${formatBytes(cat.size)} (${cat.share}%)`}
                        />
                      ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {analytics.folderList.map((folder, idx) => (
                        <div
                          key={folder.name}
                          className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-950/60"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-mono font-semibold text-slate-800 dark:text-slate-200">
                              {folder.name}
                            </span>
                            <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400">
                              {folder.share}%
                            </span>
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{folder.count} fichier(s)</span>
                            <span className="tabular-nums">{formatBytes(folder.size)}</span>
                          </div>
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${treemapColors[idx % treemapColors.length]}`}
                              style={{ width: `${Math.max(4, folder.share)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                        Répartition par type ({analytics.fileCount} fichiers)
                      </h3>
                      <div className="space-y-3">
                        {analytics.catList.map((cat) => (
                          <div key={cat.name}>
                            <div className="mb-1 flex justify-between text-[11px]">
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {cat.name} ({cat.count})
                              </span>
                              <span className="font-mono text-slate-500">
                                {formatBytes(cat.size)} • {cat.share}%
                              </span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-amber-500 to-indigo-500"
                                style={{ width: `${Math.max(3, cat.share)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                        Fichiers les plus volumineux
                      </h3>
                      <div className="space-y-1.5">
                        {analytics.largest.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => {
                              onJumpToEntry(entry.path);
                              onClose();
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-left hover:bg-amber-500/10 dark:bg-slate-950/60"
                          >
                            <span className="truncate font-mono text-[11px]">{entry.path}</span>
                            <span className="shrink-0 font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                              {formatBytes(entry.size)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {analytics.bestCompressed.length > 0 && (
                      <div className="rounded-2xl border border-slate-200 p-4 md:col-span-2 dark:border-slate-800">
                        <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                          Meilleurs taux de compression
                        </h3>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {analytics.bestCompressed.map(({ entry, saving }) => (
                            <div
                              key={entry.path}
                              className="flex items-center justify-between rounded-xl bg-emerald-50/60 px-3 py-2 dark:bg-emerald-950/25"
                            >
                              <span className="truncate font-mono text-[11px]">{entry.name}</span>
                              <span className="ml-2 shrink-0 rounded-md bg-emerald-500/20 px-2 py-0.5 font-mono font-bold text-emerald-700 dark:text-emerald-300">
                                -{saving}% ({formatBytes(entry.size)} → {formatBytes(entry.compressedSize)})
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Archive Diff Comparator */}
          {tab === 'diff' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold text-slate-600 dark:text-slate-300">
                    Archive de référence (Gauche / v1)
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={diffLeftPath}
                      onChange={(e) => setDiffLeftPath(e.target.value)}
                      placeholder="Chemin vers archive_v1.orar..."
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const p = await open({ multiple: false });
                        if (typeof p === 'string') setDiffLeftPath(p);
                      }}
                      className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
                    >
                      ...
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block font-semibold text-slate-600 dark:text-slate-300">
                    Archive comparée (Droite / v2)
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={diffRightPath}
                      onChange={(e) => setDiffRightPath(e.target.value)}
                      placeholder="Chemin vers archive_v2.orar..."
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const p = await open({ multiple: false });
                        if (typeof p === 'string') setDiffRightPath(p);
                      }}
                      className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
                    >
                      ...
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={diffLoading || !diffLeftPath.trim() || !diffRightPath.trim()}
                  onClick={runDiff}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                >
                  {diffLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitCompare className="h-4 w-4" />
                  )}
                  Comparer les deux archives
                </button>

                {diffReport && (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {(
                      [
                        ['all', `Tous (${diffReport.items.length})`],
                        ['modified', `Modifiés (${diffReport.modifiedCount})`],
                        ['added', `Ajoutés (${diffReport.addedCount})`],
                        ['removed', `Supprimés (${diffReport.removedCount})`],
                      ] as const
                    ).map(([k, lbl]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setDiffFilter(k)}
                        className={`rounded-lg px-2.5 py-1 font-semibold ${
                          diffFilter === k
                            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {diffReport && (
                <div className="max-h-[45vh] overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 bg-slate-100 font-semibold text-slate-600 dark:bg-slate-950 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Statut</th>
                        <th className="px-3 py-2">Chemin dans l'archive</th>
                        <th className="px-3 py-2 text-right">Avant</th>
                        <th className="px-3 py-2 text-right">Après</th>
                        <th className="px-3 py-2 text-right">Delta</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
                      {diffItemsFiltered.map((item) => (
                        <tr key={item.path} className="hover:bg-slate-50 dark:hover:bg-slate-950/60">
                          <td className="px-3 py-2">
                            <span
                              className={`inline-block rounded-md px-1.5 py-0.5 font-bold uppercase ${
                                item.status === 'added'
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : item.status === 'removed'
                                    ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                    : item.status === 'modified'
                                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                              }`}
                            >
                              {item.status === 'added'
                                ? 'Ajouté'
                                : item.status === 'removed'
                                  ? 'Supprimé'
                                  : item.status === 'modified'
                                    ? 'Modifié'
                                    : 'Identique'}
                            </span>
                          </td>
                          <td className="max-w-[320px] truncate px-3 py-2 font-mono">{item.path}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                            {item.leftSize !== null ? formatBytes(item.leftSize) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                            {item.rightSize !== null ? formatBytes(item.rightSize) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {item.sizeDelta === 0
                              ? '0 o'
                              : item.sizeDelta > 0
                                ? `+${formatBytes(item.sizeDelta)}`
                                : `-${formatBytes(Math.abs(item.sizeDelta))}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 3. Universal Archive Converter */}
          {tab === 'convert' && (
            <div className="mx-auto max-w-xl space-y-4">
              {!archive ? (
                <EmptyArchiveHint text="Ouvrez d'abord une archive (.rar, .7z, .zip, .tar.gz...) pour la convertir vers un autre format." />
              ) : (
                <>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/60">
                    Source : <span className="font-mono font-semibold">{archive.fileName}</span> ({archive.format})
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block font-semibold text-slate-600 dark:text-slate-300">
                        Format cible
                      </label>
                      <select
                        value={convertFormat}
                        onChange={(e) => {
                          const fmt = e.target.value;
                          setConvertFormat(fmt);
                          setConvertOutput(replaceArchiveExtension(archive.archivePath, fmt));
                        }}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value="orar">.ORAR (Signature + AES-256)</option>
                        <option value="zip">.ZIP (Universel)</option>
                        <option value="7z">.7Z (LZMA Compact)</option>
                        <option value="tar.gz">.TAR.GZ</option>
                        <option value="tar.zst">.TAR.ZST (Zstandard)</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block font-semibold text-slate-600 dark:text-slate-300">
                        Compression
                      </label>
                      <select
                        value={convertLevel}
                        onChange={(e) => setConvertLevel(Number(e.target.value))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value={0}>0 — Aucune (Store)</option>
                        <option value={1}>1 — Rapide</option>
                        <option value={6}>6 — Normale</option>
                        <option value={9}>9 — Ultra</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block font-semibold text-slate-600 dark:text-slate-300">
                      Fichier de sortie
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={convertOutput}
                        onChange={(e) => setConvertOutput(e.target.value)}
                        className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const p = await save({ defaultPath: convertOutput });
                          if (p) setConvertOutput(p);
                        }}
                        className="rounded-xl border border-slate-200 px-3 py-2 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        Parcourir
                      </button>
                    </div>
                  </div>

                  {convertFormat === 'orar' && (
                    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/50">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <Lock className="h-3.5 w-3.5 text-amber-500" />
                        Chiffrer l'archive convertie (optionnel)
                      </div>
                      <input
                        type="password"
                        value={convertPassword}
                        onChange={(e) => setConvertPassword(e.target.value)}
                        placeholder="Nouveau mot de passe AES-256..."
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                      />
                      {convertPassword && (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={convertEncryptNames}
                            onChange={(e) => setConvertEncryptNames(e.target.checked)}
                            className="accent-amber-500"
                          />
                          <span>Chiffrer aussi les noms de fichiers</span>
                        </label>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={convertLoading || !convertOutput.trim()}
                    onClick={runConvert}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                  >
                    {convertLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    Convertir et ouvrir l'archive .{convertFormat}
                  </button>
                </>
              )}
            </div>
          )}

          {/* 4. Split & Join Volumes */}
          {tab === 'volumes' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                  Découper en volumes (.part001, .part002...)
                </h3>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={splitTargetPath}
                    onChange={(e) => setSplitTargetPath(e.target.value)}
                    placeholder="Chemin de l'archive ou du fichier..."
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await open({ multiple: false });
                      if (typeof p === 'string') setSplitTargetPath(p);
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    ...
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                    Taille par volume (Mo)
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[10, 25, 100, 500].map((mb) => (
                      <button
                        key={mb}
                        type="button"
                        onClick={() => setSplitSizeMb(mb)}
                        className={`rounded-lg px-2.5 py-1 font-semibold ${
                          splitSizeMb === mb
                            ? 'bg-amber-500 text-white'
                            : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {mb} Mo
                      </button>
                    ))}
                    <input
                      type="number"
                      min={1}
                      value={splitSizeMb}
                      onChange={(e) => setSplitSizeMb(Math.max(1, Number(e.target.value)))}
                      className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-center font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  disabled={splitLoading || !splitTargetPath.trim()}
                  onClick={runSplit}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                >
                  {splitLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Découper le fichier
                </button>

                {splitReport && (
                  <div className="space-y-1 rounded-xl bg-emerald-50 p-3 text-[11px] text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    <div className="font-semibold">
                      {splitReport.parts.length} volume(s) généré(s) ({formatBytes(splitReport.totalSize)})
                    </div>
                    <div className="font-mono text-[10px] break-all opacity-80">
                      SHA-256 : {splitReport.sha256}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                  Rassembler des volumes (.part001)
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Sélectionnez le premier volume <span className="font-mono">.part001</span> : ORar détecte et fusionne automatiquement toutes les parties suivantes.
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={joinFirstPart}
                    onChange={(e) => setJoinFirstPart(e.target.value)}
                    placeholder="Chemin vers fichier.orar.part001..."
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await open({ multiple: false });
                      if (typeof p === 'string') setJoinFirstPart(p);
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    ...
                  </button>
                </div>

                <button
                  type="button"
                  disabled={splitLoading || !joinFirstPart.trim()}
                  onClick={runJoin}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 font-semibold text-white hover:bg-indigo-700 disabled:opacity-45"
                >
                  {splitLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Rassembler les volumes
                </button>

                {joinedPath && (
                  <div className="space-y-2 rounded-xl bg-indigo-50 p-3 text-[11px] text-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-200">
                    <div className="font-semibold">Fichier reconstitué :</div>
                    <div className="font-mono text-[10px] break-all">{joinedPath}</div>
                    {isSupportedArchivePath(joinedPath) && (
                      <button
                        type="button"
                        onClick={async () => {
                          await onOpenArchive(joinedPath);
                          onClose();
                        }}
                        className="rounded-lg bg-indigo-600 px-3 py-1 font-semibold text-white"
                      >
                        Ouvrir l'archive reconstituée
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 5. Repair Archive */}
          {tab === 'repair' && (
            <div className="mx-auto max-w-xl space-y-4">
              <p className="text-slate-600 dark:text-slate-300">
                Scanne une archive <span className="font-mono">.orar</span> ou{' '}
                <span className="font-mono">.zip</span> endommagée, isole les blocs corrompus et reconstruit un fichier sain <span className="font-mono">_repaired</span>.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={repairPath}
                  onChange={(e) => setRepairPath(e.target.value)}
                  placeholder="Chemin de l'archive à réparer..."
                  className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const p = await open({
                      multiple: false,
                      filters: [{ name: 'ORar / ZIP', extensions: ['orar', 'zip'] }],
                    });
                    if (typeof p === 'string') setRepairPath(p);
                  }}
                  className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
                >
                  Parcourir
                </button>
              </div>
              <button
                type="button"
                disabled={repairLoading || !repairPath.trim()}
                onClick={runRepair}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
              >
                {repairLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                Lancer la réparation
              </button>

              {repairReport && (
                <div className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                  <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                    {repairReport.message}
                  </div>
                  <div className="font-mono text-[11px] break-all text-slate-600 dark:text-slate-300">
                    Sortie : {repairReport.outputPath}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await onOpenArchive(repairReport.outputPath);
                      onClose();
                    }}
                    className="rounded-xl bg-emerald-600 px-3 py-1.5 font-semibold text-white"
                  >
                    Ouvrir l'archive réparée
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Backup Profiles & Batch Operations */}
          {tab === 'backup' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* 1-Click Backup Profiles */}
              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                    Profils de Sauvegarde en 1 clic
                  </h3>
                  <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    Horodaté
                  </span>
                </div>

                <div className="space-y-2">
                  {backupProfiles.map((prof) => (
                    <div
                      key={prof.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-950/60"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
                          <span className="truncate">{prof.name}</span>
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[9px] uppercase dark:bg-slate-800">
                            .{prof.format}
                          </span>
                          {prof.smartDevIgnore && (
                            <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700 dark:text-indigo-300">
                              Smart Dev
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                          {prof.sourcePaths.join(' + ')} → {prof.destinationDir}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={profileRunningId === prof.id}
                          onClick={() => runBackupProfile(prof)}
                          className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                        >
                          {profileRunningId === prof.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          Lancer
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            persistBackupProfiles(backupProfiles.filter((p) => p.id !== prof.id))
                          }
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                          title="Supprimer ce profil"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* New Profile Form */}
                <div className="space-y-2 rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">
                    Nouveau profil de sauvegarde
                  </div>
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Nom du profil (ex: Mes Documents)"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        const sel = await open({ directory: true, multiple: true });
                        if (sel) {
                          const list = Array.isArray(sel) ? sel : [sel];
                          setNewProfileSources((prev) => Array.from(new Set([...prev, ...list])));
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 dark:border-slate-700"
                    >
                      <Plus className="h-3 w-3" />
                      Dossiers sources ({newProfileSources.length})
                    </button>
                    <select
                      value={newProfileFormat}
                      onChange={(e) => setNewProfileFormat(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="orar">.ORAR</option>
                      <option value="zip">.ZIP</option>
                      <option value="7z">.7Z</option>
                    </select>
                    <label className="inline-flex items-center gap-1 px-1">
                      <input
                        type="checkbox"
                        checked={newProfileIgnore}
                        onChange={(e) => setNewProfileIgnore(e.target.checked)}
                        className="accent-amber-500"
                      />
                      Smart Dev
                    </label>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={newProfileDest}
                      onChange={(e) => setNewProfileDest(e.target.value)}
                      placeholder="Dossier de destination..."
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const d = await open({ directory: true, multiple: false });
                        if (typeof d === 'string') setNewProfileDest(d);
                      }}
                      className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                    >
                      ...
                    </button>
                  </div>
                  {newProfileFormat === 'orar' && (
                    <input
                      type="password"
                      value={newProfilePassword}
                      onChange={(e) => setNewProfilePassword(e.target.value)}
                      placeholder="Mot de passe AES-256 du profil (optionnel)..."
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                    />
                  )}
                  <button
                    type="button"
                    disabled={!newProfileName.trim() || newProfileSources.length === 0 || !newProfileDest.trim()}
                    onClick={handleAddBackupProfile}
                    className="w-full rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-45"
                  >
                    Enregistrer le profil
                  </button>
                </div>
              </div>

              {/* Batch Processor */}
              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                  Traitement par lots (Batch Compressor / Extractor)
                </h3>
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 p-1 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => {
                      setBatchMode('compress_each');
                      setBatchSources([]);
                    }}
                    className={`rounded-lg py-1.5 font-semibold ${
                      batchMode === 'compress_each'
                        ? 'bg-amber-500 text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Compresser chacun
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchMode('extract_each');
                      setBatchSources([]);
                    }}
                    className={`rounded-lg py-1.5 font-semibold ${
                      batchMode === 'extract_each'
                        ? 'bg-amber-500 text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Extraire chacun
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      const sel = await open({
                        directory: batchMode === 'compress_each',
                        multiple: true,
                      });
                      if (sel) {
                        const list = Array.isArray(sel) ? sel : [sel];
                        setBatchSources((prev) => Array.from(new Set([...prev, ...list])));
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 dark:border-slate-700"
                  >
                    <Plus className="h-3.5 w-3.5 text-amber-500" />
                    {batchMode === 'compress_each' ? 'Ajouter dossiers' : 'Ajouter archives'}
                  </button>
                  {batchMode === 'compress_each' && (
                    <button
                      type="button"
                      onClick={async () => {
                        const sel = await open({ directory: false, multiple: true });
                        if (sel) {
                          const list = Array.isArray(sel) ? sel : [sel];
                          setBatchSources((prev) => Array.from(new Set([...prev, ...list])));
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 dark:border-slate-700"
                    >
                      <Plus className="h-3.5 w-3.5 text-indigo-500" />
                      Ajouter fichiers
                    </button>
                  )}
                  {batchSources.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setBatchSources([])}
                      className="rounded-xl px-2 py-1 text-slate-400 hover:text-rose-500"
                    >
                      Vider ({batchSources.length})
                    </button>
                  )}
                </div>

                {batchSources.length > 0 && (
                  <div className="max-h-24 space-y-1 overflow-y-auto rounded-xl bg-slate-50 p-2 font-mono text-[10px] dark:bg-slate-950/60">
                    {batchSources.map((s) => (
                      <div key={s} className="truncate">
                        {s}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={batchDestDir}
                    onChange={(e) => setBatchDestDir(e.target.value)}
                    placeholder="Dossier de sortie pour le lot..."
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const d = await open({ directory: true, multiple: false });
                      if (typeof d === 'string') setBatchDestDir(d);
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    ...
                  </button>
                </div>

                {batchMode === 'compress_each' && (
                  <div className="flex items-center gap-3">
                    <select
                      value={batchFormat}
                      onChange={(e) => setBatchFormat(e.target.value)}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="orar">.ORAR</option>
                      <option value="zip">.ZIP</option>
                      <option value="7z">.7Z</option>
                      <option value="tar.zst">.TAR.ZST</option>
                    </select>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={batchSmartIgnore}
                        onChange={(e) => setBatchSmartIgnore(e.target.checked)}
                        className="accent-amber-500"
                      />
                      <span>Smart Dev Ignore</span>
                    </label>
                  </div>
                )}

                <button
                  type="button"
                  disabled={batchLoading || batchSources.length === 0 || !batchDestDir.trim()}
                  onClick={runBatch}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                >
                  {batchLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Layers className="h-4 w-4" />
                  )}
                  Exécuter le lot ({batchSources.length})
                </button>

                {batchReport && (
                  <div className="space-y-1 rounded-xl bg-emerald-50 p-3 text-[11px] text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    <div className="font-semibold">{batchReport.message}</div>
                    {batchReport.failed.length > 0 && (
                      <div className="text-rose-600 dark:text-rose-300">
                        {batchReport.failed.join(' • ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stego-ORar PNG Camouflage & Standalone SFX Bundle */}
          {tab === 'stego' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Stego-ORar PNG */}
              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                  <EyeOff className="h-4 w-4 text-amber-500" />
                  Stego-ORar : Dissimuler dans une image PNG
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Cache votre archive dans une image <span className="font-mono">.png</span> valide (ouvrable dans Windows Photos) et l'extrait uniquement via ORar.
                </p>

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={stegoSourceArchive}
                    onChange={(e) => setStegoSourceArchive(e.target.value)}
                    placeholder="Archive source (.orar, .zip...)"
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await open({ multiple: false });
                      if (typeof p === 'string') {
                        setStegoSourceArchive(p);
                        if (!stegoOutputPng) setStegoOutputPng(`${p.replace(/\.[^.]+$/, '')}_stego.png`);
                      }
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    ...
                  </button>
                </div>

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={stegoCoverPng}
                    onChange={(e) => setStegoCoverPng(e.target.value)}
                    placeholder="Image PNG porteuse (optionnel — générée auto si vide)"
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await open({
                        multiple: false,
                        filters: [{ name: 'Image PNG', extensions: ['png'] }],
                      });
                      if (typeof p === 'string') setStegoCoverPng(p);
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    PNG
                  </button>
                </div>

                <input
                  type="text"
                  value={stegoOutputPng}
                  onChange={(e) => setStegoOutputPng(e.target.value)}
                  placeholder="Chemin PNG de sortie..."
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                />

                <button
                  type="button"
                  disabled={stegoLoading || !stegoSourceArchive.trim() || !stegoOutputPng.trim()}
                  onClick={runCreateStego}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                >
                  {stegoLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5" />
                  )}
                  Camoufler dans le PNG
                </button>

                <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
                  <div className="mb-1.5 font-semibold text-slate-800 dark:text-slate-200">
                    Révéler une archive cachée depuis un PNG
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={stegoRevealPng}
                      onChange={(e) => setStegoRevealPng(e.target.value)}
                      placeholder="Image Stego-ORar (.png)..."
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const p = await open({
                          multiple: false,
                          filters: [{ name: 'Image PNG', extensions: ['png'] }],
                        });
                        if (typeof p === 'string') setStegoRevealPng(p);
                      }}
                      className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                    >
                      ...
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={stegoLoading || !stegoRevealPng.trim()}
                    onClick={runRevealStego}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 font-semibold text-white hover:bg-indigo-700 disabled:opacity-45"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Révéler & Ouvrir l'archive cachée
                  </button>
                </div>

                {stegoReport && (
                  <div className="rounded-xl bg-emerald-50 p-3 text-[11px] text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    {stegoReport.message}
                  </div>
                )}
              </div>

              {/* Standalone Windows SFX (.cmd) */}
              <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                  <PackageCheck className="h-4 w-4 text-emerald-500" />
                  Paquet Auto-Extractible Windows (.cmd SFX)
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Génère un fichier autonome <span className="font-mono">_SFX.cmd</span> exécutable sur n'importe quel PC Windows 10/11 par simple double-clic, même si ORar n'y est pas installé.
                </p>

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={sfxSourceArchive}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSfxSourceArchive(val);
                      setSfxOutputPath(`${val.replace(/\.[^.]+$/, '')}_SFX.cmd`);
                    }}
                    placeholder="Archive à transformer en SFX..."
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await open({ multiple: false });
                      if (typeof p === 'string') {
                        setSfxSourceArchive(p);
                        setSfxOutputPath(`${p.replace(/\.[^.]+$/, '')}_SFX.cmd`);
                      }
                    }}
                    className="rounded-xl border border-slate-200 px-2.5 py-1.5 dark:border-slate-700"
                  >
                    ...
                  </button>
                </div>

                <input
                  type="text"
                  value={sfxOutputPath}
                  onChange={(e) => setSfxOutputPath(e.target.value)}
                  placeholder="Chemin de sortie (_SFX.cmd)..."
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                />

                <button
                  type="button"
                  disabled={sfxLoading || !sfxSourceArchive.trim()}
                  onClick={runCreateSfx}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700 disabled:opacity-45"
                >
                  {sfxLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PackageCheck className="h-3.5 w-3.5" />
                  )}
                  Générer l'auto-extractible Windows
                </button>

                {sfxReport && (
                  <div className="space-y-2 rounded-xl bg-emerald-50 p-3 text-[11px] text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    <div className="font-semibold">
                      {sfxReport.message} ({formatBytes(sfxReport.sfxSize)})
                    </div>
                    <div className="font-mono text-[10px] break-all">{sfxReport.sfxOutputPath}</div>
                    <button
                      type="button"
                      onClick={() => invoke('reveal_in_explorer', { path: sfxReport.sfxOutputPath })}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 font-semibold text-white"
                    >
                      <FolderSearch className="h-3 w-3" />
                      Afficher dans l'Explorateur
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 6. CPU Benchmark */}
          {tab === 'benchmark' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                    Benchmark de compression en mémoire (corpus mixte 4 Mo)
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Compare la vitesse réelle de votre processeur et le taux de réduction entre les moteurs ORar et ZIP.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={benchLoading}
                  onClick={runBenchmark}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {benchLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Gauge className="h-4 w-4" />
                  )}
                  {benchLoading ? 'Mesure en cours...' : 'Lancer le benchmark'}
                </button>
              </div>

              {benchResults.length > 0 && (
                <div className="space-y-2.5">
                  {benchResults.map((res) => (
                    <div
                      key={res.levelLabel}
                      className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/60"
                    >
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {res.levelLabel}
                        </span>
                        <div className="flex items-center gap-3 font-mono text-[11px]">
                          <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-700 dark:text-emerald-300">
                            Gain : {res.ratioPercent.toFixed(1)}%
                          </span>
                          <span className="text-slate-500">
                            {formatBytes(res.compressedSize)}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                            <span>Compression ({res.compressMs} ms)</span>
                            <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                              {res.compressMbS.toFixed(0)} Mo/s
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <div
                              className="h-full rounded-full bg-amber-500"
                              style={{ width: `${Math.min(100, (res.compressMbS / maxSpeed) * 100)}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                            <span>Décompression ({res.decompressMs} ms)</span>
                            <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                              {res.decompressMbS.toFixed(0)} Mo/s
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <div
                              className="h-full rounded-full bg-indigo-500"
                              style={{ width: `${Math.min(100, (res.decompressMbS / maxSpeed) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 7. Windows Integration */}
          {tab === 'windows' && (
            <div className="mx-auto max-w-xl space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/60">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  Intégration native Windows (HKCU — Sans droits administrateur)
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Enregistre ORar pour votre session Windows afin d'ouvrir les fichiers{' '}
                  <span className="font-mono">.orar</span> par double-clic et d'ajouter « Ouvrir avec ORar » dans le menu clic-droit.
                </p>
                {winStatus && (
                  <p className="mt-2 truncate font-mono text-[10px] text-slate-400">
                    Exécutable : {winStatus.exePath}
                  </p>
                )}
              </div>

              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                <div>
                  <div className="font-semibold">Associer l'extension .orar à ORar</div>
                  <div className="text-[11px] text-slate-500">
                    Ouvre automatiquement tout fichier .orar dans ORar
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={assocOrar}
                  onChange={(e) => setAssocOrar(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                <div>
                  <div className="font-semibold">Menu contextuel Windows « Ouvrir avec ORar »</div>
                  <div className="text-[11px] text-slate-500">
                    Ajoute un raccourci clic-droit sur vos fichiers Windows
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={ctxMenu}
                  onChange={(e) => setCtxMenu(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={winSaving}
                  onClick={saveWindowsIntegration}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Appliquer à Windows
                </button>

                {archive && (
                  <button
                    type="button"
                    onClick={() => invoke('reveal_in_explorer', { path: archive.archivePath })}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <FolderSearch className="h-4 w-4" />
                    Afficher l'archive dans l'Explorateur
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyArchiveHint({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {text}
    </div>
  );
}
