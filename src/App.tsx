import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  Archive,
  ArrowUp,
  ArrowUpCircle,
  ArrowUpDown,
  Binary,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  File,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Lock,
  MessageSquareText,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { ContextMenu } from './components/ContextMenu';
import { CreateArchiveModal } from './components/CreateArchiveModal';
import { FolderTree } from './components/FolderTree';
import { IntegrityModal } from './components/IntegrityModal';
import { OrarLogo } from './components/OrarLogo';
import { PasswordModal } from './components/PasswordModal';
import { PreviewPane } from './components/PreviewPane';
import { ToolsCenterModal } from './components/ToolsCenterModal';
import { UpdateModal } from './components/UpdateModal';
import {
  AppUpdateInfo,
  ArchiveEntry,
  ArchiveInfo,
  ArchiveMutationRequest,
  CreateArchiveRequest,
  DirectoryListing,
  EntryHashes,
  FilterKind,
  IntegrityReport,
  PreviewFileResponse,
  ProgressPayload,
  RecentArchive,
  SidebarTab,
  SortDirection,
  SortField,
  ToolsTab,
  UpdateInstallReport,
} from './types';
import {
  buildFolderTree,
  computeSavingPercent,
  formatBytes,
  formatCrc32,
  getDirectChildren,
  getExtension,
  getFileCategory,
  isSupportedArchivePath,
  parsePasswordError,
} from './utils';

const RECENT_STORAGE_KEY = 'orar:recent';
const THEME_STORAGE_KEY = 'orar:theme';

function loadRecentArchives(): RecentArchive[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() =>
    document.documentElement.classList.contains('dark')
  );
  const [archive, setArchive] = useState<ArchiveInfo | null>(null);
  const [sessionPassword, setSessionPassword] = useState<string | null>(null);
  const [currentDir, setCurrentDir] = useState<string>('');
  const [selectedArchivePaths, setSelectedArchivePaths] = useState<Set<string>>(new Set());
  const [activeEntry, setActiveEntry] = useState<ArchiveEntry | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [preview, setPreview] = useState<PreviewFileResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [entryHashes, setEntryHashes] = useState<EntryHashes | null>(null);
  const [hashesLoading, setHashesLoading] = useState<boolean>(false);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('archive');
  const [pcListing, setPcListing] = useState<DirectoryListing | null>(null);
  const [pcLoading, setPcLoading] = useState<boolean>(false);
  const [selectedPcPaths, setSelectedPcPaths] = useState<Set<string>>(new Set());
  const [recentArchives, setRecentArchives] = useState<RecentArchive[]>(loadRecentArchives);

  const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
  const [createInitialSources, setCreateInitialSources] = useState<string[]>([]);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);

  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState<boolean>(false);
  const [updateChecking, setUpdateChecking] = useState<boolean>(false);
  const [updateInstalling, setUpdateInstalling] = useState<boolean>(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const [toolsModalOpen, setToolsModalOpen] = useState<boolean>(false);
  const [toolsInitialTab, setToolsInitialTab] = useState<ToolsTab>('analytics');

  const [passwordPrompt, setPasswordPrompt] = useState<{
    reason: string;
    archiveLabel: string;
    onSuccess: (pw: string) => void;
  } | null>(null);

  const [nameDialog, setNameDialog] = useState<{
    title: string;
    initialValue: string;
    confirmLabel: string;
    onConfirm: (val: string) => Promise<void>;
  } | null>(null);
  const [nameDialogValue, setNameDialogValue] = useState('');
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: ArchiveEntry;
  } | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);
  const [copiedManifest, setCopiedManifest] = useState<boolean>(false);

  const showStatus = useCallback((kind: 'ok' | 'err', text: string) => {
    setStatusMessage({ kind, text });
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const toggleTheme = () => {
    setDarkMode((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle('dark', next);
      document.documentElement.style.colorScheme = next ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
      } catch {
        // Ignore storage error
      }
      return next;
    });
  };

  const pushRecentArchive = useCallback((info: ArchiveInfo) => {
    setRecentArchives((prev) => {
      const next: RecentArchive[] = [
        {
          path: info.archivePath,
          name: info.fileName,
          format: info.format,
          openedAt: new Date().toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
        ...prev.filter((item) => item.path !== info.archivePath),
      ].slice(0, 6);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage error
      }
      return next;
    });
  }, []);

  const loadDirectory = useCallback(
    async (dirPath?: string) => {
      setPcLoading(true);
      try {
        const listing = await invoke<DirectoryListing>('list_directory', {
          dirPath: dirPath ?? null,
        });
        setPcListing(listing);
        setSelectedPcPaths(new Set());
      } catch (err) {
        showStatus('err', String(err));
      } finally {
        setPcLoading(false);
      }
    },
    [showStatus]
  );

  const handleCheckUpdates = useCallback(
    async (silent = false) => {
      setUpdateChecking(true);
      if (!silent) setUpdateError(null);
      try {
        const info = await invoke<AppUpdateInfo>('check_app_update');
        setUpdateInfo(info);
        setUpdateError(null);
        if (!silent && !info.updateAvailable) {
          showStatus('ok', `ORar v${info.currentVersion} est à jour.`);
        }
      } catch (err) {
        if (!silent) {
          setUpdateError(String(err));
        }
      } finally {
        setUpdateChecking(false);
      }
    },
    [showStatus]
  );

  const handleDownloadAndInstallUpdate = useCallback(async () => {
    if (!updateInfo?.installerUrl) return;
    setUpdateInstalling(true);
    setUpdateError(null);
    try {
      const report = await invoke<UpdateInstallReport>('download_and_install_update', {
        installerUrl: updateInfo.installerUrl,
        installerName: updateInfo.installerName,
      });
      showStatus('ok', report.message);
    } catch (err) {
      setUpdateError(String(err));
      showStatus('err', String(err));
    } finally {
      setUpdateInstalling(false);
    }
  }, [showStatus, updateInfo]);

  const handleOpenReleasesPage = useCallback(async () => {
    const url = updateInfo?.htmlUrl || 'https://github.com/Logan-FORNIER/ORar/releases';
    try {
      await invoke('open_external_url', { url });
    } catch (err) {
      showStatus('err', String(err));
    }
  }, [showStatus, updateInfo]);

  useEffect(() => {
    loadDirectory();
    handleCheckUpdates(true);
  }, [loadDirectory]);

  const requestPassword = useCallback(
    (reason: string, archiveLabel: string, onSuccess: (pw: string) => void) => {
      setPasswordPrompt({ reason, archiveLabel, onSuccess });
    },
    []
  );

  const openArchivePath = useCallback(
    async (path: string, pwOverride?: string) => {
      setBusy(true);
      const pwToUse = pwOverride !== undefined ? pwOverride : path === archive?.archivePath ? sessionPassword : null;
      try {
        const info = await invoke<ArchiveInfo>('inspect_archive', {
          path,
          password: pwToUse,
        });
        setArchive(info);
        setSessionPassword(pwToUse ?? null);
        setCurrentDir('');
        setSelectedArchivePaths(new Set());
        setActiveEntry(null);
        setPreview(null);
        setPreviewError(null);
        setEntryHashes(null);
        setSearchQuery('');
        setFilterKind('all');
        setSidebarTab('archive');
        pushRecentArchive(info);
        showStatus('ok', `Archive ouverte : ${info.fileName} (${info.fileCount} fichier(s))`);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, path, (pw) => {
            setSessionPassword(pw);
            openArchivePath(path, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [archive?.archivePath, pushRecentArchive, requestPassword, sessionPassword, showStatus]
  );

  // Check if launched with a file argument from Windows Explorer
  useEffect(() => {
    invoke<string | null>('get_launch_args')
      .then((argPath) => {
        if (argPath && isSupportedArchivePath(argPath)) {
          openArchivePath(argPath);
        }
      })
      .catch(() => {});
    // Run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to real-time backend progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ProgressPayload>('orar://progress', (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Native Tauri drag-and-drop listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDraggingFiles(true);
        } else if (payload.type === 'leave') {
          setIsDraggingFiles(false);
        } else if (payload.type === 'drop') {
          setIsDraggingFiles(false);
          const dropped = payload.paths;
          if (!dropped || dropped.length === 0) return;
          if (dropped.length === 1 && isSupportedArchivePath(dropped[0])) {
            openArchivePath(dropped[0]);
          } else {
            setCreateInitialSources(dropped);
            setCreateModalOpen(true);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [openArchivePath]);

  const handleOpenArchiveDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: 'Ouvrir une archive',
      filters: [
        {
          name: 'Archives supportées',
          extensions: ['orar', 'zip', '7z', 'rar', 'gz', 'tgz', 'zst', 'tzst', 'xz', 'txz', 'tar'],
        },
        { name: 'Archive ORar (.orar)', extensions: ['orar'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    });
    if (typeof selected === 'string') {
      await openArchivePath(selected);
    }
  }, [openArchivePath]);

  const handleCreateArchive = async (req: CreateArchiveRequest) => {
    setBusy(true);
    setProgress({
      operation: 'compress',
      currentFile: 'Préparation...',
      processed: 0,
      total: 1,
      percent: 0,
    });
    try {
      const info = await invoke<ArchiveInfo>('create_archive', { req });
      setCreateModalOpen(false);
      setArchive(info);
      setSessionPassword(req.password);
      setCurrentDir('');
      setSelectedArchivePaths(new Set());
      setActiveEntry(null);
      setPreview(null);
      setEntryHashes(null);
      setSidebarTab('archive');
      pushRecentArchive(info);
      showStatus(
        'ok',
        `Archive ${info.format} créée : ${info.fileName} (${formatBytes(info.archiveFileSize)})${
          req.splitSizeBytes ? ' + volumes .part' : ''
        }`
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runExtractWithDest = useCallback(
    async (dest: string, selectedList: string[] | null, pwOverride?: string) => {
      if (!archive) return;
      const pwToUse = pwOverride ?? sessionPassword;
      setBusy(true);
      setProgress({
        operation: 'extract',
        currentFile: archive.fileName,
        processed: 0,
        total: 1,
        percent: 0,
      });
      try {
        const msg = await invoke<string>('extract_archive', {
          req: {
            archivePath: archive.archivePath,
            destinationDir: dest,
            selectedEntries: selectedList,
            password: pwToUse,
          },
        });
        showStatus('ok', msg);
        if (sidebarTab === 'pc') {
          loadDirectory(pcListing?.currentPath);
        }
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            runExtractWithDest(dest, selectedList, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [archive, loadDirectory, pcListing?.currentPath, requestPassword, sessionPassword, showStatus, sidebarTab]
  );

  const handleExtract = useCallback(
    async (onlySelected: boolean, explicitList?: string[]) => {
      if (!archive) return;
      const selectedList = explicitList ?? (onlySelected ? Array.from(selectedArchivePaths) : null);
      if (onlySelected && (!selectedList || selectedList.length === 0)) return;

      const dest = await open({
        directory: true,
        multiple: false,
        title: onlySelected
          ? `Extraire ${selectedList?.length ?? 0} élément(s) vers...`
          : "Choisir le dossier d'extraction",
      });
      if (typeof dest !== 'string') return;
      await runExtractWithDest(dest, selectedList);
    },
    [archive, runExtractWithDest, selectedArchivePaths]
  );

  const handleTestIntegrity = useCallback(
    async (pwOverride?: string) => {
      if (!archive) return;
      const pwToUse = pwOverride ?? sessionPassword;
      setBusy(true);
      setProgress({
        operation: 'verify',
        currentFile: archive.fileName,
        processed: 0,
        total: 1,
        percent: 0,
      });
      try {
        const report = await invoke<IntegrityReport>('test_archive_integrity', {
          archivePath: archive.archivePath,
          password: pwToUse,
        });
        setIntegrityReport(report);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleTestIntegrity(pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const handleCreateDemo = async () => {
    setBusy(true);
    setProgress({
      operation: 'compress',
      currentFile: 'ORar_Demo.orar',
      processed: 0,
      total: 1,
      percent: 0,
    });
    try {
      const info = await invoke<ArchiveInfo>('create_demo_archive');
      setArchive(info);
      setSessionPassword(null);
      setCurrentDir('');
      setSelectedArchivePaths(new Set());
      setActiveEntry(null);
      setPreview(null);
      setEntryHashes(null);
      setSidebarTab('archive');
      pushRecentArchive(info);
      showStatus('ok', `Archive démo générée et ouverte : ${info.fileName}`);
    } catch (err) {
      showStatus('err', String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleSelectEntry = useCallback(
    async (entry: ArchiveEntry, pwOverride?: string) => {
      setActiveEntry(entry);
      setEntryHashes(null);
      if (entry.isDir || !archive) {
        setPreview(null);
        setPreviewError(null);
        return;
      }

      const pwToUse = pwOverride ?? sessionPassword;
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const resp = await invoke<PreviewFileResponse>('preview_archive_entry', {
          archivePath: archive.archivePath,
          entryPath: entry.path,
          password: pwToUse,
        });
        setPreview(resp);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          setPreview(null);
          setPreviewError(pwReason);
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleSelectEntry(entry, pw);
          });
        } else {
          setPreview(null);
          setPreviewError(String(err));
        }
      } finally {
        setPreviewLoading(false);
      }
    },
    [archive, requestPassword, sessionPassword]
  );

  const handleComputeHashes = useCallback(
    async (entry: ArchiveEntry, pwOverride?: string) => {
      if (!archive || entry.isDir) return;
      setHashesLoading(true);
      try {
        const hashes = await invoke<EntryHashes>('compute_entry_hashes', {
          archivePath: archive.archivePath,
          entryPath: entry.path,
          password: pwOverride ?? sessionPassword,
        });
        setEntryHashes(hashes);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleComputeHashes(entry, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setHashesLoading(false);
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const handleOpenExternal = useCallback(
    async (entry: ArchiveEntry, pwOverride?: string) => {
      if (!archive || entry.isDir) return;
      try {
        await invoke<string>('open_entry_externally', {
          archivePath: archive.archivePath,
          entryPath: entry.path,
          password: pwOverride ?? sessionPassword,
        });
        showStatus('ok', `Ouvert dans Windows : ${entry.name}`);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleOpenExternal(entry, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const runArchiveMutation = useCallback(
    async (req: ArchiveMutationRequest, successText: string) => {
      setBusy(true);
      try {
        const updated = await invoke<ArchiveInfo>('mutate_archive', {
          req: { ...req, password: req.password ?? sessionPassword },
        });
        setArchive(updated);
        setSelectedArchivePaths(new Set());
        setActiveEntry(null);
        setPreview(null);
        setEntryHashes(null);
        showStatus('ok', successText);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason && archive) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            runArchiveMutation({ ...req, password: pw }, successText);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const handleAddFilesToArchive = async (directories: boolean) => {
    if (!archive?.canMutate) return;
    const selected = await open({
      directory: directories,
      multiple: true,
      title: directories
        ? 'Ajouter des dossiers dans le répertoire courant'
        : 'Ajouter des fichiers dans le répertoire courant',
    });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    await runArchiveMutation(
      {
        archivePath: archive.archivePath,
        action: 'add',
        targetDir: currentDir,
        sourcePaths: list,
      },
      `${list.length} élément(s) ajouté(s) à l'archive.`
    );
  };

  const handleSaveTextEntry = useCallback(
    async (entry: ArchiveEntry, newText: string, pwOverride?: string) => {
      if (!archive?.canMutate) return;
      setBusy(true);
      const pwToUse = pwOverride ?? sessionPassword;
      try {
        const updated = await invoke<ArchiveInfo>('mutate_archive', {
          req: {
            archivePath: archive.archivePath,
            action: 'write_text',
            newPath: entry.path,
            textContent: newText,
            password: pwToUse,
          },
        });
        setArchive(updated);
        const refreshed = updated.entries.find((e) => e.path === entry.path) ?? null;
        setActiveEntry(refreshed);
        setEntryHashes(null);
        if (refreshed) {
          const resp = await invoke<PreviewFileResponse>('preview_archive_entry', {
            archivePath: updated.archivePath,
            entryPath: refreshed.path,
            password: pwToUse,
          });
          setPreview(resp);
          setPreviewError(null);
        }
        showStatus('ok', `Modifications enregistrées dans « ${entry.name} ».`);
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleSaveTextEntry(entry, newText, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const handleOpenNewTextFileDialog = () => {
    if (!archive?.canMutate) return;
    setNameDialogValue('note.md');
    setNameDialog({
      title: 'Nouveau fichier texte dans l’archive',
      initialValue: 'note.md',
      confirmLabel: 'Créer et éditer',
      onConfirm: async (fileName) => {
        const clean = fileName
          .trim()
          .replace(/^[/\\]+|[/\\]+$/g, '')
          .replace(/\.\./g, '');
        if (!clean) return;
        const full = currentDir ? `${currentDir}/${clean}` : clean;
        setBusy(true);
        try {
          const updated = await invoke<ArchiveInfo>('mutate_archive', {
            req: {
              archivePath: archive.archivePath,
              action: 'write_text',
              newPath: full,
              textContent: '# Nouveau document\n\n',
              password: sessionPassword,
            },
          });
          setArchive(updated);
          setSelectedArchivePaths(new Set());
          const created = updated.entries.find((e) => e.path === full) ?? null;
          setActiveEntry(created);
          setEntryHashes(null);
          if (created) {
            const resp = await invoke<PreviewFileResponse>('preview_archive_entry', {
              archivePath: updated.archivePath,
              entryPath: created.path,
              password: sessionPassword,
            });
            setPreview(resp);
            setPreviewError(null);
          }
          showStatus('ok', `Fichier « ${clean} » créé dans l'archive.`);
          setNameDialog(null);
        } catch (err) {
          const pwReason = parsePasswordError(err);
          if (pwReason) {
            requestPassword(pwReason, archive.fileName, async (pw) => {
              setSessionPassword(pw);
              const updated = await invoke<ArchiveInfo>('mutate_archive', {
                req: {
                  archivePath: archive.archivePath,
                  action: 'write_text',
                  newPath: full,
                  textContent: '# Nouveau document\n\n',
                  password: pw,
                },
              });
              setArchive(updated);
              const created = updated.entries.find((e) => e.path === full) ?? null;
              setActiveEntry(created);
              if (created) {
                const resp = await invoke<PreviewFileResponse>('preview_archive_entry', {
                  archivePath: updated.archivePath,
                  entryPath: created.path,
                  password: pw,
                });
                setPreview(resp);
              }
              setNameDialog(null);
            });
          } else {
            showStatus('err', String(err));
          }
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const handleSaveArchiveComment = useCallback(
    async (nextComment: string, pwOverride?: string) => {
      if (!archive?.canMutate) return;
      setBusy(true);
      const pwToUse = pwOverride ?? sessionPassword;
      const normalized = nextComment.trim();
      try {
        const updated = await invoke<ArchiveInfo>('mutate_archive', {
          req: {
            archivePath: archive.archivePath,
            action: 'set_comment',
            comment: normalized ? normalized : null,
            password: pwToUse,
          },
        });
        setArchive(updated);
        setCommentDialogOpen(false);
        showStatus(
          'ok',
          normalized ? 'Note Markdown enregistrée dans l’archive.' : 'Note d’archive supprimée.'
        );
      } catch (err) {
        const pwReason = parsePasswordError(err);
        if (pwReason) {
          requestPassword(pwReason, archive.fileName, (pw) => {
            setSessionPassword(pw);
            handleSaveArchiveComment(nextComment, pw);
          });
        } else {
          showStatus('err', String(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [archive, requestPassword, sessionPassword, showStatus]
  );

  const handleOpenNewFolderDialog = () => {
    if (!archive?.canMutate) return;
    setNameDialogValue('');
    setNameDialog({
      title: 'Nouveau dossier dans l’archive',
      initialValue: '',
      confirmLabel: 'Créer le dossier',
      onConfirm: async (folderName) => {
        const clean = folderName.trim().replace(/^[/\\]+|[/\\]+$/g, '');
        if (!clean) return;
        const full = currentDir ? `${currentDir}/${clean}` : clean;
        await runArchiveMutation(
          {
            archivePath: archive.archivePath,
            action: 'mkdir',
            dirPath: full,
          },
          `Dossier « ${clean} » créé dans l'archive.`
        );
        setNameDialog(null);
      },
    });
  };

  const handleOpenRenameDialog = useCallback(
    (entry: ArchiveEntry) => {
      if (!archive?.canMutate) return;
      setNameDialogValue(entry.name);
      setNameDialog({
        title: `Renommer « ${entry.name} »`,
        initialValue: entry.name,
        confirmLabel: 'Renommer',
        onConfirm: async (newName) => {
          const clean = newName.trim().replace(/[/\\]/g, '');
          if (!clean || clean === entry.name) {
            setNameDialog(null);
            return;
          }
          const slash = entry.path.lastIndexOf('/');
          const parent = slash === -1 ? '' : entry.path.slice(0, slash);
          const nextPath = parent ? `${parent}/${clean}` : clean;
          await runArchiveMutation(
            {
              archivePath: archive.archivePath,
              action: 'rename',
              oldPath: entry.path,
              newPath: nextPath,
            },
            `Renommé en « ${clean} ».`
          );
          setNameDialog(null);
        },
      });
    },
    [archive, runArchiveMutation]
  );

  const handleDeleteEntries = useCallback(
    async (paths: string[]) => {
      if (!archive?.canMutate || paths.length === 0) return;
      await runArchiveMutation(
        {
          archivePath: archive.archivePath,
          action: 'delete',
          paths,
        },
        `${paths.length} élément(s) supprimé(s) de l'archive.`
      );
    },
    [archive, runArchiveMutation]
  );

  const handleJumpToEntry = useCallback(
    (entryPath: string) => {
      if (!archive) return;
      const slash = entryPath.lastIndexOf('/');
      setCurrentDir(slash === -1 ? '' : entryPath.slice(0, slash));
      setSearchQuery('');
      setFilterKind('all');
      const target = archive.entries.find((e) => e.path === entryPath);
      if (target) {
        handleSelectEntry(target);
      }
    },
    [archive, handleSelectEntry]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';

      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenArchiveDialog();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setCreateInitialSources([]);
        setCreateModalOpen(true);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e' && archive) {
        e.preventDefault();
        handleExtract(false);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f' && archive) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setToolsInitialTab('search');
        setToolsModalOpen(true);
      } else if (e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setToolsInitialTab('benchmark');
        setToolsModalOpen(true);
      } else if (e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setToolsInitialTab('repair');
        setToolsModalOpen(true);
      } else if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setToolsInitialTab('analytics');
        setToolsModalOpen(true);
      } else if (!isInput && e.key === 'F2' && archive?.canMutate && activeEntry) {
        e.preventDefault();
        handleOpenRenameDialog(activeEntry);
      } else if (!isInput && e.key === 'Delete' && archive?.canMutate) {
        const targets =
          selectedArchivePaths.size > 0
            ? Array.from(selectedArchivePaths)
            : activeEntry
              ? [activeEntry.path]
              : [];
        if (targets.length > 0) {
          e.preventDefault();
          handleDeleteEntries(targets);
        }
      } else if (!isInput && e.key === 'Backspace' && archive && currentDir) {
        e.preventDefault();
        const slash = currentDir.lastIndexOf('/');
        setCurrentDir(slash === -1 ? '' : currentDir.slice(0, slash));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeEntry,
    archive,
    currentDir,
    handleDeleteEntries,
    handleExtract,
    handleOpenArchiveDialog,
    handleOpenRenameDialog,
    selectedArchivePaths,
  ]);

  const folderTree = useMemo(
    () => (archive ? buildFolderTree(archive.entries) : []),
    [archive]
  );

  const visibleEntries = useMemo(() => {
    if (!archive) return [];
    const trimmedQuery = searchQuery.trim().toLowerCase();

    const baseList = trimmedQuery
      ? archive.entries.filter(
          (e) =>
            e.name.toLowerCase().includes(trimmedQuery) ||
            e.path.toLowerCase().includes(trimmedQuery)
        )
      : getDirectChildren(archive.entries, currentDir);

    const filtered = baseList.filter((e) => {
      if (filterKind === 'all') return true;
      return getFileCategory(e) === filterKind;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      let cmp = 0;
      switch (sortField) {
        case 'name':
          cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'compressedSize':
          cmp = a.compressedSize - b.compressedSize;
          break;
        case 'ratio': {
          const rA = computeSavingPercent(a.size, a.compressedSize) ?? -999;
          const rB = computeSavingPercent(b.size, b.compressedSize) ?? -999;
          cmp = rA - rB;
          break;
        }
        case 'crc32':
          cmp = (a.crc32 ?? 0) - (b.crc32 ?? 0);
          break;
        case 'modified':
          cmp = (a.modified ?? '').localeCompare(b.modified ?? '');
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [archive, currentDir, searchQuery, filterKind, sortField, sortDirection]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const toggleArchiveRowSelection = (path: string) => {
    setSelectedArchivePaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allVisibleSelected =
    visibleEntries.length > 0 && visibleEntries.every((e) => selectedArchivePaths.has(e.path));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedArchivePaths(new Set());
    } else {
      setSelectedArchivePaths(new Set(visibleEntries.map((e) => e.path)));
    }
  };

  const breadcrumbs = useMemo(() => {
    if (!currentDir) return [];
    const parts = currentDir.split('/');
    return parts.map((label, idx) => ({
      label,
      path: parts.slice(0, idx + 1).join('/'),
    }));
  }, [currentDir]);

  const navigateParentDir = () => {
    if (!currentDir) return;
    const slash = currentDir.lastIndexOf('/');
    setCurrentDir(slash === -1 ? '' : currentDir.slice(0, slash));
  };

  const globalSaving = archive
    ? computeSavingPercent(archive.totalUncompressedSize, archive.totalCompressedSize)
    : null;

  const handleCopyManifest = async () => {
    if (!archive?.sha256Manifest) return;
    try {
      await navigator.clipboard.writeText(archive.sha256Manifest);
      setCopiedManifest(true);
      setTimeout(() => setCopiedManifest(false), 1500);
    } catch {
      // Ignore clipboard error
    }
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-[#0b0e14] dark:text-slate-100">
      {/* Native Drag & Drop Overlay */}
      {isDraggingFiles && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-amber-500/15 backdrop-blur-xs">
          <div className="rounded-3xl border-2 border-dashed border-amber-500 bg-white/95 px-10 py-8 text-center shadow-2xl dark:bg-slate-900/95">
            <Upload className="mx-auto mb-3 h-10 w-10 text-amber-500" />
            <div className="text-base font-bold text-slate-900 dark:text-slate-100">
              Déposez ici dans ORar
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Une archive sera ouverte instantanément • Des fichiers ou dossiers ouvriront l'assistant de compression
            </p>
          </div>
        </div>
      )}

      {/* Top Toolbar */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/95">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <OrarLogo className="h-9 w-9 shrink-0 shadow-sm" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
                  ORar
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUpdateModalOpen(true);
                    handleCheckUpdates(false);
                  }}
                  title={
                    updateInfo?.updateAvailable
                      ? `Mise à jour disponible : ${updateInfo.tagName} (cliquer pour installer)`
                      : 'Vérifier les mises à jour et releases GitHub'
                  }
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold transition ${
                    updateInfo?.updateAvailable
                      ? 'animate-pulse bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30 dark:text-emerald-300'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`}
                >
                  {updateInfo?.updateAvailable && <ArrowUpCircle className="h-3 w-3" />}
                  {updateInfo?.updateAvailable
                    ? `MAJ ${updateInfo.tagName}`
                    : `v${updateInfo?.currentVersion ?? '0.1.0'}`}
                </button>
                {archive && (
                  <span className="rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                    .{archive.format}
                  </span>
                )}
                {archive?.isEncrypted && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    <Lock className="h-2.5 w-2.5" />
                    AES-256
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {archive ? archive.fileName : 'Gestionnaire d’archives multi-formats'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={handleOpenArchiveDialog}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            title="Ctrl+O"
          >
            <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
            Ouvrir
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCreateInitialSources([]);
              setCreateModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-amber-600 disabled:opacity-40"
            title="Ctrl+N"
          >
            <Plus className="h-3.5 w-3.5" />
            Nouvelle archive
          </button>

          <div className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-slate-700" />

          <button
            type="button"
            disabled={busy || !archive}
            onClick={() => handleExtract(false)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            title="Ctrl+E"
          >
            <Download className="h-3.5 w-3.5 text-indigo-500" />
            Extraire tout
          </button>

          <button
            type="button"
            disabled={busy || !archive || selectedArchivePaths.size === 0}
            onClick={() => handleExtract(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <Layers className="h-3.5 w-3.5 text-emerald-500" />
            Extraire ({selectedArchivePaths.size})
          </button>

          <button
            type="button"
            disabled={busy || !archive}
            onClick={() => handleTestIntegrity()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            Intégrité
          </button>

          <div className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-slate-700" />

          <button
            type="button"
            disabled={busy || !archive}
            onClick={() => {
              setToolsInitialTab('search');
              setToolsModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            title="Recherche plein texte dans les fichiers (Alt+F)"
          >
            <Search className="h-3.5 w-3.5 text-sky-500" />
            Plein texte
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setToolsInitialTab(archive ? 'analytics' : 'benchmark');
              setToolsModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/70"
            title="Analyseur, Convertisseur, Volumes, Réparation, Benchmark, Windows (Alt+T)"
          >
            <Activity className="h-3.5 w-3.5" />
            Outils Pro
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleCreateDemo}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-40 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70"
            title="Créer et ouvrir une archive .orar de démonstration"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Démo
          </button>

          {archive && (
            <button
              type="button"
              onClick={() => invoke('reveal_in_explorer', { path: archive.archivePath })}
              className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              title="Afficher l'archive dans l'Explorateur Windows"
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            title={darkMode ? 'Passer au thème clair' : 'Passer au thème sombre'}
          >
            {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </header>

      {/* Main 3-Pane Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60">
          <div className="grid grid-cols-2 border-b border-slate-200 p-1.5 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setSidebarTab('archive')}
              className={`rounded-lg py-1.5 text-xs font-semibold transition ${
                sidebarTab === 'archive'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              Arborescence
            </button>
            <button
              type="button"
              onClick={() => setSidebarTab('pc')}
              className={`rounded-lg py-1.5 text-xs font-semibold transition ${
                sidebarTab === 'pc'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              Explorateur PC
            </button>
          </div>

          {sidebarTab === 'archive' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
              {archive ? (
                <>
                  {/* Compression stats gauge */}
                  <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-950/60">
                    <div className="flex items-center justify-between font-semibold text-slate-800 dark:text-slate-200">
                      <span>Taux de compression</span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        {globalSaving !== null ? `${globalSaving}% économisé` : '0%'}
                      </span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all"
                        style={{
                          width: `${
                            archive.totalUncompressedSize > 0
                              ? Math.min(
                                  100,
                                  Math.max(
                                    4,
                                    Math.round(
                                      (archive.totalCompressedSize / archive.totalUncompressedSize) *
                                        100
                                    )
                                  )
                                )
                              : 100
                          }%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
                      <span>Original : {formatBytes(archive.totalUncompressedSize)}</span>
                      <span>Archive : {formatBytes(archive.archiveFileSize)}</span>
                    </div>
                    <div className="mt-1.5 flex gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{archive.fileCount} fichier(s)</span>
                      <span>•</span>
                      <span>{archive.dirCount} dossier(s)</span>
                    </div>

                    {(archive.deduplicatedFiles ?? 0) > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                        <Zap className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {archive.deduplicatedFiles} doublon(s) dédupliqué(s) •{' '}
                          {formatBytes(archive.deduplicatedSavedBytes ?? 0)} économisés
                        </span>
                      </div>
                    )}

                    {archive.comment && (
                      <div className="mt-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                        <div className="line-clamp-3 italic">« {archive.comment} »</div>
                      </div>
                    )}

                    {archive.sha256Manifest && (
                      <div className="mt-2 flex items-center justify-between gap-1 rounded-lg bg-white px-2 py-1 dark:bg-slate-900">
                        <span className="truncate font-mono text-[10px] text-slate-500 dark:text-slate-400">
                          SHA256: {archive.sha256Manifest.slice(0, 16)}…
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyManifest}
                          className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          title="Copier le manifeste SHA-256"
                        >
                          {copiedManifest ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Folder Tree */}
                  <div className="mb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                    Dossiers de l'archive
                  </div>
                  <button
                    type="button"
                    onClick={() => setCurrentDir('')}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                      currentDir === ''
                        ? 'bg-amber-500/15 font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70'
                    }`}
                  >
                    <Archive className="h-3.5 w-3.5 text-amber-500" />
                    <span className="truncate">Racine ({archive.fileName})</span>
                  </button>
                  <FolderTree
                    nodes={folderTree}
                    currentDir={currentDir}
                    onSelectDir={setCurrentDir}
                  />
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  Ouvrez une archive ou cliquez sur <strong>Explorateur PC</strong> pour compresser des fichiers locaux.
                </div>
              )}
            </div>
          ) : (
            /* PC Explorer Tab */
            <div className="flex min-h-0 flex-1 flex-col">
              {pcListing && (
                <div className="flex flex-wrap gap-1 border-b border-slate-200 p-2 dark:border-slate-800">
                  {pcListing.quickPlaces.map((place) => (
                    <button
                      key={place.path}
                      type="button"
                      onClick={() => loadDirectory(place.path)}
                      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                        pcListing.currentPath === place.path
                          ? 'bg-amber-500 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                      }`}
                    >
                      <HardDrive className="h-3 w-3" />
                      {place.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
                <button
                  type="button"
                  disabled={!pcListing?.parentPath || pcLoading}
                  onClick={() => pcListing?.parentPath && loadDirectory(pcListing.parentPath)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-35 dark:hover:bg-slate-800"
                  title="Dossier parent"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <div
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300"
                  title={pcListing?.currentPath}
                >
                  {pcListing?.currentPath ?? '...'}
                </div>
                <button
                  type="button"
                  onClick={() => loadDirectory(pcListing?.currentPath)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                  title="Actualiser"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${pcLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
                {pcListing?.items.map((item) => {
                  const checked = selectedPcPaths.has(item.path);
                  const isArch = !item.isDir && isSupportedArchivePath(item.name);
                  return (
                    <div
                      key={item.path}
                      onDoubleClick={() => {
                        if (item.isDir) {
                          loadDirectory(item.path);
                        } else if (isArch) {
                          openArchivePath(item.path);
                        }
                      }}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs transition ${
                        checked
                          ? 'bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800/70'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedPcPaths((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.path)) next.delete(item.path);
                            else next.add(item.path);
                            return next;
                          })
                        }
                        className="h-3.5 w-3.5 rounded border-slate-300 accent-amber-500"
                      />
                      {item.isDir ? (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      ) : isArch ? (
                        <Archive className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                      ) : (
                        <File className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      )}
                      <span
                        className="min-w-0 flex-1 truncate"
                        onClick={() => item.isDir && loadDirectory(item.path)}
                      >
                        {item.name}
                      </span>
                      {!item.isDir && (
                        <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                          {formatBytes(item.size)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-slate-200 p-2.5 dark:border-slate-800">
                <button
                  type="button"
                  disabled={selectedPcPaths.size === 0}
                  onClick={() => {
                    setCreateInitialSources(Array.from(selectedPcPaths));
                    setCreateModalOpen(true);
                  }}
                  className="w-full rounded-xl bg-amber-500 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Compresser la sélection ({selectedPcPaths.size})
                </button>
              </div>
            </div>
          )}

          {/* Recent Archives */}
          {recentArchives.length > 0 && (
            <div className="border-t border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                <Clock className="h-3 w-3" />
                Archives récentes
              </div>
              <div className="space-y-1">
                {recentArchives.map((rec) => (
                  <button
                    key={rec.path}
                    type="button"
                    onClick={() => openArchivePath(rec.path)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    title={rec.path}
                  >
                    <span className="truncate font-medium">{rec.name}</span>
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {rec.format}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Center Main Archive Explorer */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/70 dark:bg-[#0b0e14]">
          {archive ? (
            <>
              {/* Navigation & Search bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white/80 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto text-xs">
                  <button
                    type="button"
                    disabled={!currentDir}
                    onClick={navigateParentDir}
                    className="mr-1 rounded-lg border border-slate-200 p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    title="Dossier parent (Backspace)"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentDir('')}
                    className={`rounded-md px-2 py-1 font-medium transition ${
                      currentDir === ''
                        ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    Racine
                  </button>
                  {breadcrumbs.map((crumb) => (
                    <div key={crumb.path} className="flex items-center gap-1">
                      <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                      <button
                        type="button"
                        onClick={() => setCurrentDir(crumb.path)}
                        className={`max-w-[160px] truncate rounded-md px-2 py-1 font-medium transition ${
                          currentDir === crumb.path
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                        }`}
                      >
                        {crumb.label}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {selectedArchivePaths.size > 0 && (
                    <div className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      <span>{selectedArchivePaths.size} sélectionné(s)</span>
                      <button
                        type="button"
                        onClick={() => setSelectedArchivePaths(new Set())}
                        className="rounded hover:text-amber-950 dark:hover:text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filtrer les noms (Ctrl+F)..."
                      className="w-48 rounded-xl border border-slate-200 bg-white py-1.5 pr-7 pl-8 text-xs text-slate-800 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute top-1/2 right-2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  <div className="flex rounded-xl border border-slate-200 bg-white p-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900">
                    {(
                      [
                        ['all', 'Tous'],
                        ['dirs', 'Dossiers'],
                        ['code', 'Code & Texte'],
                        ['images', 'Images'],
                        ['other', 'Autres'],
                      ] as [FilterKind, string][]
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setFilterKind(id)}
                        className={`rounded-lg px-2 py-1 font-medium transition ${
                          filterKind === id
                            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Direct In-Place Archive Editing Bar (ORAR / ZIP) */}
              {archive.canMutate && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-amber-50/40 px-4 py-1.5 text-[11px] dark:border-slate-800 dark:bg-amber-950/10">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 font-semibold text-amber-800 dark:text-amber-300">
                      Édition directe :
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleAddFilesToArchive(false)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <FilePlus className="h-3 w-3 text-amber-500" />
                      Ajouter fichiers
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleAddFilesToArchive(true)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <FolderPlus className="h-3 w-3 text-amber-500" />
                      Ajouter dossier
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleOpenNewFolderDialog}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Plus className="h-3 w-3 text-emerald-500" />
                      Nouveau dossier
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleOpenNewTextFileDialog}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      title="Créer un nouveau fichier texte ou Markdown directement dans l'archive"
                    >
                      <FileText className="h-3 w-3 text-indigo-500" />
                      Nouveau texte
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCommentDraft(archive.comment ?? '');
                        setCommentDialogOpen(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      title="Créer ou modifier la note Markdown de cette archive"
                    >
                      <MessageSquareText className="h-3 w-3 text-amber-500" />
                      Note Markdown
                    </button>
                    <button
                      type="button"
                      disabled={busy || !activeEntry}
                      onClick={() => activeEntry && handleOpenRenameDialog(activeEntry)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      title="Renommer (F2)"
                    >
                      <Pencil className="h-3 w-3 text-sky-500" />
                      Renommer
                    </button>
                    <button
                      type="button"
                      disabled={busy || (selectedArchivePaths.size === 0 && !activeEntry)}
                      onClick={() => {
                        const list =
                          selectedArchivePaths.size > 0
                            ? Array.from(selectedArchivePaths)
                            : activeEntry
                              ? [activeEntry.path]
                              : [];
                        handleDeleteEntries(list);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2 py-1 font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900/50 dark:bg-slate-900 dark:text-rose-400 dark:hover:bg-rose-950/30"
                      title="Supprimer (Suppr)"
                    >
                      <Trash2 className="h-3 w-3" />
                      Supprimer
                    </button>
                  </div>
                  <span className="hidden text-[10px] text-slate-400 xl:inline">
                    Clic droit sur une ligne pour plus d'actions • Double-clic fichier = ouvrir dans Windows
                  </span>
                </div>
              )}

              {/* Archive Markdown Note Banner */}
              {archive.comment && archive.comment.trim().length > 0 && (
                <ArchiveCommentBanner
                  comment={archive.comment}
                  canMutate={archive.canMutate}
                  onEdit={() => {
                    setCommentDraft(archive.comment ?? '');
                    setCommentDialogOpen(true);
                  }}
                />
              )}

              {/* Entries Table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100/95 text-[11px] font-semibold text-slate-600 backdrop-blur-xs dark:border-slate-800 dark:bg-slate-900/95 dark:text-slate-400">
                    <tr>
                      <th className="w-9 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          className="h-3.5 w-3.5 rounded border-slate-300 accent-amber-500"
                        />
                      </th>
                      {(
                        [
                          ['name', 'Nom', 'text-left'],
                          ['size', 'Taille', 'text-right'],
                          ['compressedSize', 'Compressé', 'text-right'],
                          ['ratio', 'Gain', 'text-right'],
                          ['crc32', 'CRC32', 'text-right'],
                          ['modified', 'Modifié', 'text-right'],
                        ] as [SortField, string, string][]
                      ).map(([field, label, align]) => (
                        <th key={field} className={`px-3 py-2 ${align}`}>
                          <button
                            type="button"
                            onClick={() => toggleSort(field)}
                            className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
                          >
                            {label}
                            <ArrowUpDown
                              className={`h-3 w-3 ${
                                sortField === field ? 'text-amber-500' : 'opacity-40'
                              }`}
                            />
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
                    {visibleEntries.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-12 text-center text-xs text-slate-500 dark:text-slate-400"
                        >
                          Aucun élément correspondant dans ce répertoire.
                        </td>
                      </tr>
                    ) : (
                      visibleEntries.map((entry) => {
                        const checked = selectedArchivePaths.has(entry.path);
                        const isActive = activeEntry?.path === entry.path;
                        const saving = entry.isDir
                          ? null
                          : computeSavingPercent(entry.size, entry.compressedSize);

                        return (
                          <tr
                            key={entry.path}
                            onClick={() => handleSelectEntry(entry)}
                            onDoubleClick={() => {
                              if (entry.isDir) {
                                setSearchQuery('');
                                setCurrentDir(entry.path);
                              } else {
                                handleOpenExternal(entry);
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setActiveEntry(entry);
                              setContextMenu({ x: e.clientX, y: e.clientY, entry });
                            }}
                            className={`cursor-pointer transition ${
                              isActive
                                ? 'bg-amber-500/15 dark:bg-amber-500/20'
                                : checked
                                  ? 'bg-indigo-500/5 dark:bg-indigo-500/10'
                                  : 'hover:bg-white dark:hover:bg-slate-900/70'
                            }`}
                          >
                            <td
                              className="px-3 py-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleArchiveRowSelection(entry.path);
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {}}
                                className="h-3.5 w-3.5 rounded border-slate-300 accent-amber-500"
                              />
                            </td>
                            <td className="max-w-[280px] px-3 py-2">
                              <div className="flex items-center gap-2">
                                <EntryIcon entry={entry} />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 truncate font-medium text-slate-800 dark:text-slate-200">
                                    <span className="truncate">{entry.name}</span>
                                    {entry.encrypted && (
                                      <Lock className="h-3 w-3 shrink-0 text-amber-500" />
                                    )}
                                    {entry.deduplicated && (
                                      <span title="Fichier dédupliqué (.orar) — partage le même bloc compressé">
                                        <Zap className="h-3 w-3 shrink-0 text-emerald-500" />
                                      </span>
                                    )}
                                  </div>
                                  {searchQuery.trim() && (
                                    <div className="truncate font-mono text-[10px] text-slate-400">
                                      {entry.path}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600 tabular-nums dark:text-slate-300">
                              {entry.isDir ? '—' : formatBytes(entry.size)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600 tabular-nums dark:text-slate-300">
                              {entry.isDir ? '—' : formatBytes(entry.compressedSize)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {saving === null ? (
                                <span className="text-slate-400">—</span>
                              ) : (
                                <span
                                  className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                                    saving > 0
                                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                      : 'bg-slate-200/70 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                                  }`}
                                >
                                  {saving > 0 ? `-${saving}%` : `${saving}%`}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {formatCrc32(entry.crc32)}
                            </td>
                            <td className="px-3 py-2 text-right text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
                              {entry.modified ?? '—'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            /* Empty / Welcome State */
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <OrarLogo className="mx-auto mb-4 h-16 w-16 shadow-md" />
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                  ORar — Édition Pro
                </h1>
                <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Gestionnaire d'archives nouvelle génération avec format{' '}
                  <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                    .orar
                  </span>{' '}
                  (accès O(1), chiffrement AES-256-GCM), édition en direct, recherche plein texte, convertisseur, volumes .part et benchmark CPU.
                </p>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleOpenArchiveDialog}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    <FolderOpen className="h-4 w-4 text-amber-500" />
                    Ouvrir une archive
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreateInitialSources([]);
                      setCreateModalOpen(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-amber-600"
                  >
                    <Plus className="h-4 w-4" />
                    Créer une archive .orar
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateDemo}
                    className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    <Sparkles className="h-4 w-4" />
                    Démo .orar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setToolsInitialTab('benchmark');
                      setToolsModalOpen(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-300"
                  >
                    <Activity className="h-4 w-4" />
                    Outils Pro & Benchmark
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Right Preview & Inspection Pane */}
        <aside className="hidden w-80 shrink-0 flex-col border-l border-slate-200 bg-white md:flex xl:w-96 dark:border-slate-800 dark:bg-slate-900/60">
          <PreviewPane
            entry={activeEntry}
            preview={preview}
            loading={previewLoading}
            error={previewError}
            hashes={entryHashes}
            hashesLoading={hashesLoading}
            canMutate={Boolean(archive?.canMutate)}
            onOpenExternal={(e) => handleOpenExternal(e)}
            onComputeHashes={(e) => handleComputeHashes(e)}
            onSaveTextContent={handleSaveTextEntry}
          />
        </aside>
      </div>

      {/* Bottom Status & Real-time Progress Bar */}
      {(progress || statusMessage) && (
        <div className="fixed right-4 bottom-4 z-40 flex max-w-md flex-col gap-2">
          {progress && (
            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-100">
                <span>
                  {progress.operation === 'compress'
                    ? 'Compression en cours...'
                    : progress.operation === 'extract'
                      ? 'Extraction en cours...'
                      : progress.operation === 'convert'
                        ? 'Conversion en cours...'
                        : progress.operation === 'search'
                          ? 'Recherche plein texte...'
                          : progress.operation === 'batch'
                            ? 'Traitement par lot en cours...'
                            : 'Vérification d’intégrité...'}
                </span>
                <span className="font-mono text-amber-600 tabular-nums dark:text-amber-400">
                  {Math.round(progress.percent)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 w-64 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all duration-150"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="mt-1.5 truncate font-mono text-[10px] text-slate-500 dark:text-slate-400">
                {progress.currentFile} ({progress.processed}/{progress.total})
              </div>
            </div>
          )}

          {statusMessage && (
            <div
              className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-xs font-medium shadow-xl ${
                statusMessage.kind === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/90 dark:text-emerald-200'
                  : 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/90 dark:text-rose-200'
              }`}
            >
              <span>{statusMessage.text}</span>
              <button
                type="button"
                onClick={() => setStatusMessage(null)}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right-Click Context Menu */}
      <ContextMenu
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        entry={contextMenu?.entry ?? null}
        canMutate={Boolean(archive?.canMutate)}
        onClose={() => setContextMenu(null)}
        onPreview={(e) => handleSelectEntry(e)}
        onOpenExternal={(e) => handleOpenExternal(e)}
        onExtractOne={(e) => handleExtract(true, [e.path])}
        onRename={(e) => handleOpenRenameDialog(e)}
        onComputeHashes={(e) => {
          handleSelectEntry(e);
          handleComputeHashes(e);
        }}
        onCopyPath={async (e) => {
          try {
            await navigator.clipboard.writeText(e.path);
            showStatus('ok', `Chemin copié : ${e.path}`);
          } catch {
            // Ignore
          }
        }}
        onDelete={(e) => handleDeleteEntries([e.path])}
      />

      {/* Inline Rename / New Folder Dialog */}
      {nameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await nameDialog.onConfirm(nameDialogValue);
            }}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {nameDialog.title}
            </h3>
            <input
              type="text"
              autoFocus
              value={nameDialogValue}
              onChange={(e) => setNameDialogValue(e.target.value)}
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNameDialog(null)}
                className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={!nameDialogValue.trim()}
                className="rounded-xl bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
              >
                {nameDialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Archive Markdown Note Editor Modal */}
      {commentDialogOpen && archive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await handleSaveArchiveComment(commentDraft);
            }}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Note Markdown de l’archive
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setCommentDialogOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Affichée sous forme de bannière à l’ouverture de l’archive (.orar / .zip). Prend en
              charge <code className="font-mono"># Titre</code>,{' '}
              <code className="font-mono">- puce</code>, <code className="font-mono">**gras**</code>{' '}
              et <code className="font-mono">`code`</code>.
            </p>
            <textarea
              rows={6}
              autoFocus
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="# Readme de l’archive&#10;- Version stable&#10;- Contient **tous les assets** et `config.json`"
              className="mt-3 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={busy || !archive.comment}
                onClick={() => handleSaveArchiveComment('')}
                className="rounded-xl px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:text-rose-400 dark:hover:bg-rose-950/30"
              >
                Effacer la note
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCommentDialogOpen(false)}
                  className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-45"
                >
                  Enregistrer
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Modals */}
      <CreateArchiveModal
        isOpen={createModalOpen}
        initialSources={createInitialSources}
        busy={busy}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleCreateArchive}
      />
      <IntegrityModal report={integrityReport} onClose={() => setIntegrityReport(null)} />
      <PasswordModal
        isOpen={Boolean(passwordPrompt)}
        reason={passwordPrompt?.reason ?? ''}
        archiveLabel={passwordPrompt?.archiveLabel ?? ''}
        onCancel={() => setPasswordPrompt(null)}
        onSubmit={(pw) => {
          const cb = passwordPrompt?.onSuccess;
          setPasswordPrompt(null);
          cb?.(pw);
        }}
      />
      <ToolsCenterModal
        isOpen={toolsModalOpen}
        initialTab={toolsInitialTab}
        archive={archive}
        sessionPassword={sessionPassword}
        onClose={() => setToolsModalOpen(false)}
        onOpenArchive={(p) => openArchivePath(p)}
        onJumpToEntry={handleJumpToEntry}
        onArchiveCreatedOrConverted={(info) => {
          setArchive(info);
          setCurrentDir('');
          setSelectedArchivePaths(new Set());
          setActiveEntry(null);
          setPreview(null);
          pushRecentArchive(info);
        }}
        onRequestPassword={(reason, onSuccess) =>
          requestPassword(reason, archive?.fileName ?? 'Archive', onSuccess)
        }
        onNotify={showStatus}
      />
      <UpdateModal
        isOpen={updateModalOpen}
        info={updateInfo}
        checking={updateChecking}
        installing={updateInstalling}
        error={updateError}
        onClose={() => setUpdateModalOpen(false)}
        onCheck={() => handleCheckUpdates(false)}
        onInstall={handleDownloadAndInstallUpdate}
        onOpenReleases={handleOpenReleasesPage}
      />
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-slate-900 dark:text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[10.5px] text-amber-900 dark:bg-amber-400/15 dark:text-amber-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function ArchiveCommentBanner({
  comment,
  canMutate,
  onEdit,
}: {
  comment: string;
  canMutate: boolean;
  onEdit: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const lines = comment.split(/\r?\n/);

  return (
    <div className="border-b border-amber-200/80 bg-gradient-to-r from-amber-50/90 via-orange-50/50 to-white px-4 py-2.5 text-xs dark:border-amber-900/40 dark:from-amber-950/30 dark:via-slate-900 dark:to-slate-900">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 hover:underline dark:text-amber-300"
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          Note Markdown de l’archive
          <span className="text-[10px] font-normal text-amber-600/80 dark:text-amber-400/80">
            ({collapsed ? 'afficher' : 'réduire'})
          </span>
        </button>
        {canMutate && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-white/80 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100/70 dark:border-amber-800/50 dark:bg-slate-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
          >
            <Pencil className="h-2.5 w-2.5" />
            Modifier la note
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-slate-700 dark:text-slate-300">
          {lines.map((rawLine, idx) => {
            const line = rawLine.trimEnd();
            if (!line.trim()) {
              return <div key={idx} className="h-1" />;
            }
            if (line.startsWith('### ')) {
              return (
                <div
                  key={idx}
                  className="text-xs font-semibold text-slate-800 dark:text-slate-100"
                >
                  {renderInlineMarkdown(line.slice(4))}
                </div>
              );
            }
            if (line.startsWith('## ')) {
              return (
                <div
                  key={idx}
                  className="text-[12.5px] font-bold text-slate-900 dark:text-slate-100"
                >
                  {renderInlineMarkdown(line.slice(3))}
                </div>
              );
            }
            if (line.startsWith('# ')) {
              return (
                <div key={idx} className="text-xs font-extrabold tracking-tight text-amber-900 dark:text-amber-200">
                  {renderInlineMarkdown(line.slice(2))}
                </div>
              );
            }
            if (line.startsWith('- ') || line.startsWith('* ')) {
              return (
                <div key={idx} className="flex items-start gap-1.5 pl-1">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>{renderInlineMarkdown(line.slice(2))}</span>
                </div>
              );
            }
            return <p key={idx}>{renderInlineMarkdown(line)}</p>;
          })}
        </div>
      )}
    </div>
  );
}

function EntryIcon({ entry }: { entry: ArchiveEntry }) {
  if (entry.isDir) {
    return <Folder className="h-4 w-4 shrink-0 text-amber-500" />;
  }
  const cat = getFileCategory(entry);
  if (cat === 'images') {
    return <ImageIcon className="h-4 w-4 shrink-0 text-indigo-500" />;
  }
  if (cat === 'code') {
    return <FileCode className="h-4 w-4 shrink-0 text-sky-500" />;
  }
  const ext = getExtension(entry.name);
  if (ext === 'bin' || ext === 'exe' || ext === 'dll') {
    return <Binary className="h-4 w-4 shrink-0 text-violet-500" />;
  }
  return <File className="h-4 w-4 shrink-0 text-slate-400" />;
}
