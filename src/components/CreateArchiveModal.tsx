import { useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  Eye,
  EyeOff,
  FilePlus,
  Filter,
  FolderPlus,
  Layers,
  Lock,
  Scissors,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { CreateArchiveRequest } from '../types';
import {
  measurePasswordStrength,
  replaceArchiveExtension,
  suggestOutputArchivePath,
} from '../utils';

interface CreateArchiveModalProps {
  isOpen: boolean;
  initialSources: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (req: CreateArchiveRequest) => Promise<void>;
}

const FORMAT_OPTIONS = [
  {
    id: 'orar',
    label: '.ORAR',
    badge: 'Signature',
    desc: 'Format maison O(1), AES-256 & SHA-256',
  },
  {
    id: 'zip',
    label: '.ZIP',
    badge: 'Universel',
    desc: 'Compatible Windows, macOS, Linux & web',
  },
  {
    id: '7z',
    label: '.7Z',
    badge: 'Compact',
    desc: 'Forte compression LZMA via libarchive',
  },
  {
    id: 'tar.gz',
    label: '.TAR.GZ',
    badge: 'Standard',
    desc: 'Archive Unix/Linux classique compressée gzip',
  },
  {
    id: 'tar.zst',
    label: '.TAR.ZST',
    badge: 'Rapide',
    desc: 'Compression moderne Zstandard très véloce',
  },
  {
    id: 'tar',
    label: '.TAR',
    badge: 'Brut',
    desc: 'Conteneur sans perte de temps de compression',
  },
];

const COMPRESSION_LEVELS = [
  { level: 0, label: 'Aucune (Store)', hint: '0 — Archivage instantané' },
  { level: 1, label: 'Rapide', hint: '1 — Priorité à la vitesse' },
  { level: 6, label: 'Normale', hint: '6 — Équilibre optimal' },
  { level: 9, label: 'Ultra', hint: '9 — Taille minimale' },
];

const SPLIT_PRESETS = [
  { label: 'Aucun découpage (fichier unique)', bytes: 0 },
  { label: '10 Mo (Discord / Messagerie)', bytes: 10 * 1024 * 1024 },
  { label: '25 Mo (Pièce jointe Email)', bytes: 25 * 1024 * 1024 },
  { label: '100 Mo (GitHub / Cloud)', bytes: 100 * 1024 * 1024 },
  { label: '500 Mo (Volume moyen)', bytes: 500 * 1024 * 1024 },
];

export function CreateArchiveModal({
  isOpen,
  initialSources,
  busy,
  onClose,
  onSubmit,
}: CreateArchiveModalProps) {
  const [sources, setSources] = useState<string[]>([]);
  const [format, setFormat] = useState<string>('orar');
  const [compressionLevel, setCompressionLevel] = useState<number>(6);
  const [comment, setComment] = useState<string>('');
  const [outputPath, setOutputPath] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [encryptFilenames, setEncryptFilenames] = useState<boolean>(false);
  const [splitBytes, setSplitBytes] = useState<number>(0);
  const [smartDevIgnore, setSmartDevIgnore] = useState<boolean>(false);
  const [excludeInput, setExcludeInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const deduped = Array.from(new Set(initialSources));
    setSources(deduped);
    setFormat('orar');
    setCompressionLevel(6);
    setComment('');
    setPassword('');
    setShowPassword(false);
    setEncryptFilenames(false);
    setSplitBytes(0);
    setSmartDevIgnore(false);
    setExcludeInput('');
    setOutputPath(suggestOutputArchivePath(deduped, 'orar'));
    setError(null);
  }, [isOpen, initialSources]);

  if (!isOpen) return null;

  const handleFormatChange = (nextFormat: string) => {
    setFormat(nextFormat);
    if (outputPath.trim()) {
      setOutputPath(replaceArchiveExtension(outputPath.trim(), nextFormat));
    } else {
      setOutputPath(suggestOutputArchivePath(sources, nextFormat));
    }
  };

  const handleAddFiles = async () => {
    const selected = await open({ multiple: true, title: 'Ajouter des fichiers à compresser' });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    const next = Array.from(new Set([...sources, ...list]));
    setSources(next);
    if (!outputPath.trim()) {
      setOutputPath(suggestOutputArchivePath(next, format));
    }
  };

  const handleAddFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: true,
      title: 'Ajouter un dossier à compresser',
    });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    const next = Array.from(new Set([...sources, ...list]));
    setSources(next);
    if (!outputPath.trim()) {
      setOutputPath(suggestOutputArchivePath(next, format));
    }
  };

  const handleBrowseOutput = async () => {
    const chosen = await save({
      title: "Enregistrer l'archive sous",
      defaultPath: outputPath || suggestOutputArchivePath(sources, format),
      filters: [
        { name: 'Archive ORar', extensions: ['orar'] },
        { name: 'Archive ZIP', extensions: ['zip'] },
        { name: 'Archive 7-Zip', extensions: ['7z'] },
        { name: 'Archive TAR.GZ', extensions: ['tar.gz', 'tgz'] },
        { name: 'Archive TAR.ZST', extensions: ['tar.zst', 'zst'] },
        { name: 'Archive TAR', extensions: ['tar'] },
      ],
    });
    if (chosen) {
      setOutputPath(chosen);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (sources.length === 0) {
      setError('Ajoutez au moins un fichier ou un dossier source.');
      return;
    }
    if (!outputPath.trim()) {
      setError('Choisissez un chemin de destination pour la nouvelle archive.');
      return;
    }
    try {
      await onSubmit({
        sourcePaths: sources,
        outputPath: outputPath.trim(),
        format,
        compressionLevel,
        comment: comment.trim() ? comment.trim() : null,
        password: format === 'orar' && password.trim() ? password.trim() : null,
        encryptFilenames: format === 'orar' && Boolean(password.trim()) && encryptFilenames,
        splitSizeBytes: splitBytes > 0 ? splitBytes : null,
        smartDevIgnore,
        excludePatterns: excludeInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const supportsLevel = format === 'orar' || format === 'zip' || format === 'tar.gz';
  const supportsComment = format === 'orar' || format === 'zip';
  const supportsEncryption = format === 'orar';
  const strength = measurePasswordStrength(password);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Créer une nouvelle archive
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Compression multi-formats, chiffrement AES-256-GCM et découpage en volumes
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Source list */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
                Sources ({sources.length})
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAddFiles}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <FilePlus className="h-3.5 w-3.5" />
                  Ajouter fichiers
                </button>
                <button
                  type="button"
                  onClick={handleAddFolder}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  Ajouter dossier
                </button>
              </div>
            </div>

            {sources.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-400">
                Aucun élément sélectionné. Ajoutez des fichiers ou un dossier ci-dessus.
              </div>
            ) : (
              <div className="max-h-28 space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-800 dark:bg-slate-950/50">
                {sources.map((src) => (
                  <div
                    key={src}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1 text-xs shadow-2xs dark:bg-slate-900"
                  >
                    <span className="truncate font-mono text-[11px] text-slate-700 dark:text-slate-300">
                      {src}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSources((prev) => prev.filter((item) => item !== src))}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Format selector */}
          <div>
            <span className="mb-2 block text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
              Format d'archive
            </span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {FORMAT_OPTIONS.map((opt) => {
                const active = format === opt.id;
                const isSignature = opt.id === 'orar';
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleFormatChange(opt.id)}
                    className={`flex flex-col items-start rounded-xl border p-2.5 text-left transition ${
                      active
                        ? 'border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/20 dark:border-amber-400 dark:bg-amber-500/15'
                        : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="font-mono text-xs font-bold text-slate-900 dark:text-slate-100">
                        {opt.label}
                      </span>
                      <span
                        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                          isSignature
                            ? 'bg-amber-500 text-white'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {isSignature && <Sparkles className="h-2.5 w-2.5" />}
                        {opt.badge}
                      </span>
                    </div>
                    <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Compression level */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
                Niveau de compression
              </span>
              {!supportsLevel && (
                <span className="text-[11px] text-slate-400">
                  Réglage automatique pour .{format}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {COMPRESSION_LEVELS.map((lvl) => {
                const active = compressionLevel === lvl.level;
                return (
                  <button
                    key={lvl.level}
                    type="button"
                    disabled={!supportsLevel}
                    onClick={() => setCompressionLevel(lvl.level)}
                    className={`rounded-xl border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
                      active
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-900 dark:border-indigo-400 dark:bg-indigo-500/15 dark:text-indigo-100'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-semibold">{lvl.label}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{lvl.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* AES-256 Encryption section for .orar */}
          {supportsEncryption && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                  <Lock className="h-3.5 w-3.5 text-amber-500" />
                  Chiffrement AES-256-GCM (optionnel)
                </span>
                {password && (
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    {strength.label}
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Laisser vide pour une archive non chiffrée..."
                  className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pr-9 pl-3 text-xs text-slate-900 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              {password && (
                <>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className={`h-full transition-all ${strength.color}`}
                      style={{ width: `${strength.percent}%` }}
                    />
                  </div>
                  <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={encryptFilenames}
                      onChange={(e) => setEncryptFilenames(e.target.checked)}
                      className="h-3.5 w-3.5 rounded accent-amber-500"
                    />
                    <span>Chiffrer aussi les noms de fichiers (table d'index protégée)</span>
                  </label>
                </>
              )}
            </div>
          )}

          {/* Output path & split volumes */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
                Fichier de sortie
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={outputPath}
                  onChange={(e) => setOutputPath(e.target.value)}
                  placeholder="E:\Archives\mon_projet.orar"
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={handleBrowseOutput}
                  className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  Parcourir
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
                <Scissors className="h-3 w-3" />
                Découper en volumes
              </label>
              <select
                value={splitBytes}
                onChange={(e) => setSplitBytes(Number(e.target.value))}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {SPLIT_PRESETS.map((preset) => (
                  <option key={preset.bytes} value={preset.bytes}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Smart Dev Ignore & Custom Exclusion Patterns */}
          <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/50">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={smartDevIgnore}
                onChange={(e) => setSmartDevIgnore(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded accent-amber-500"
              />
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                  <Filter className="h-3.5 w-3.5 text-indigo-500" />
                  Mode Smart Dev Ignore (Projets & Sauvegardes propres)
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Exclut automatiquement <span className="font-mono">node_modules</span>,{' '}
                  <span className="font-mono">target</span>, <span className="font-mono">.git</span>,{' '}
                  <span className="font-mono">dist</span>, <span className="font-mono">__pycache__</span>,{' '}
                  <span className="font-mono">.venv</span>, <span className="font-mono">*.log</span> et{' '}
                  <span className="font-mono">*.tmp</span>.
                </p>
              </div>
            </label>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-300">
                Exclusions supplémentaires (séparées par des virgules, optionnel)
              </label>
              <input
                type="text"
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                placeholder="Ex : *.bak, *.iso, cache/, secrets.txt"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-800 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {supportsComment && (
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
                Commentaire d'archive (optionnel)
              </label>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Ex : Sauvegarde projet v1.0"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-xl px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy || sources.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Compression en cours...' : `Créer l'archive .${format}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
