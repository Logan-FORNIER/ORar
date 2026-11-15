import { useCallback, useEffect, useState } from 'react';
import {
  Binary,
  Check,
  Copy,
  ExternalLink,
  File,
  FileCode,
  Fingerprint,
  Image as ImageIcon,
  Loader2,
  Lock,
  Pencil,
  Save,
  X,
  Zap,
} from 'lucide-react';
import { ArchiveEntry, EntryHashes, PreviewFileResponse } from '../types';
import { computeSavingPercent, formatBytes, formatCrc32 } from '../utils';

interface PreviewPaneProps {
  entry: ArchiveEntry | null;
  preview: PreviewFileResponse | null;
  loading: boolean;
  error: string | null;
  hashes: EntryHashes | null;
  hashesLoading: boolean;
  canMutate: boolean;
  onOpenExternal: (entry: ArchiveEntry) => void;
  onComputeHashes: (entry: ArchiveEntry) => void;
  onSaveTextContent: (entry: ArchiveEntry, newText: string) => Promise<void>;
}

export function PreviewPane({
  entry,
  preview,
  loading,
  error,
  hashes,
  hashesLoading,
  canMutate,
  onOpenExternal,
  onComputeHashes,
  onSaveTextContent,
}: PreviewPaneProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [draftText, setDraftText] = useState<string>('');
  const [savingEdit, setSavingEdit] = useState<boolean>(false);

  useEffect(() => {
    setCopiedKey(null);
    setIsEditing(false);
    setDraftText('');
  }, [entry?.path]);

  const handleSaveEdit = useCallback(async () => {
    if (!entry || savingEdit) return;
    setSavingEdit(true);
    try {
      await onSaveTextContent(entry, draftText);
      setIsEditing(false);
    } finally {
      setSavingEdit(false);
    }
  }, [draftText, entry, onSaveTextContent, savingEdit]);

  const copyValue = async (key: string, value: string | null | undefined) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Clipboard write unavailable
    }
  };

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800/80 dark:text-slate-500">
          <File className="h-6 w-6" />
        </div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Aperçu & Inspection Pro
        </h3>
        <p className="mt-1 max-w-[235px] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Sélectionnez un fichier pour lire son contenu, calculer ses empreintes SHA-256 / MD5 ou l'ouvrir directement dans Windows.
        </p>
      </div>
    );
  }

  const saving = computeSavingPercent(entry.size, entry.compressedSize);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Metadata header */}
      <div className="border-b border-slate-200 p-3.5 dark:border-slate-800">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {entry.name}
              </h3>
              {entry.encrypted && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                  title="Chiffré AES-256-GCM"
                >
                  <Lock className="h-2.5 w-2.5" />
                  AES
                </span>
              )}
              {entry.deduplicated && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
                  title="Bloc physique partagé sans réécriture (déduplication ORar)"
                >
                  <Zap className="h-2.5 w-2.5" />
                  Dédupliqué
                </span>
              )}
            </div>
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400"
              title={entry.path}
            >
              {entry.path}
            </p>
          </div>
        </div>

        {/* Quick actions for files */}
        {!entry.isDir && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onOpenExternal(entry)}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-500/10 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-500/20 dark:bg-indigo-500/20 dark:text-indigo-300"
            >
              <ExternalLink className="h-3 w-3" />
              Ouvrir dans Windows
            </button>

            <button
              type="button"
              onClick={() => onComputeHashes(entry)}
              disabled={hashesLoading}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {hashesLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Fingerprint className="h-3 w-3 text-violet-500" />
              )}
              Empreintes
            </button>

            {preview && (preview.textContent || preview.hexDump) && (
              <button
                type="button"
                onClick={() => copyValue('preview', preview.textContent ?? preview.hexDump)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                {copiedKey === 'preview' ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copiedKey === 'preview' ? 'Copié' : 'Copier'}
              </button>
            )}
          </div>
        )}

        <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-[11px]">
          <div className="rounded-lg bg-slate-100/80 px-2.5 py-1.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">Taille : </span>
            <span className="font-semibold text-slate-800 tabular-nums dark:text-slate-200">
              {entry.isDir ? 'Dossier' : formatBytes(entry.size)}
            </span>
          </div>
          <div className="rounded-lg bg-slate-100/80 px-2.5 py-1.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">Compressé : </span>
            <span className="font-semibold text-slate-800 tabular-nums dark:text-slate-200">
              {entry.isDir ? '—' : formatBytes(entry.compressedSize)}
              {saving !== null &&
                !entry.isDir &&
                ` (${saving >= 0 ? `-${saving}%` : `+${Math.abs(saving)}%`})`}
            </span>
          </div>
          <div className="rounded-lg bg-slate-100/80 px-2.5 py-1.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">Méthode : </span>
            <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
              {entry.compressionMethod}
            </span>
          </div>
          <div className="rounded-lg bg-slate-100/80 px-2.5 py-1.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">CRC32 : </span>
            <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
              {formatCrc32(entry.crc32)}
            </span>
          </div>
        </div>

        {/* Computed Cryptographic Hashes Card */}
        {hashes && hashes.path === entry.path && (
          <div className="mt-2.5 space-y-1 rounded-xl border border-violet-200 bg-violet-50/70 p-2.5 text-[10px] dark:border-violet-900/50 dark:bg-violet-950/30">
            <div className="font-semibold text-violet-900 dark:text-violet-200">
              Empreintes cryptographiques complètes
            </div>
            {(
              [
                ['CRC32', hashes.crc32Hex],
                ['MD5', hashes.md5Hex],
                ['SHA-1', hashes.sha1Hex],
                ['SHA-256', hashes.sha256Hex],
              ] as [string, string][]
            ).map(([label, val]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <span className="w-14 shrink-0 font-semibold text-slate-500 dark:text-slate-400">
                  {label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-slate-800 dark:text-slate-200">
                  {val}
                </span>
                <button
                  type="button"
                  onClick={() => copyValue(label, val)}
                  className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  title={`Copier ${label}`}
                >
                  {copiedKey === label ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview body */}
      <div className="flex-1 overflow-auto p-3.5">
        {entry.isDir ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
            Double-cliquez sur le dossier dans la liste pour explorer son contenu.
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
            Lecture depuis l'archive...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        ) : preview?.kind === 'image' && preview.base64Content ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <div className="flex items-center gap-1.5 self-start text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <ImageIcon className="h-3.5 w-3.5 text-indigo-500" />
              Aperçu image ({preview.mimeType})
            </div>
            <div className="orar-checkerboard flex max-h-[380px] w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <img
                src={`data:${preview.mimeType ?? 'image/png'};base64,${preview.base64Content}`}
                alt={preview.name}
                className="max-h-full max-w-full object-contain [image-rendering:pixelated]"
              />
            </div>
          </div>
        ) : preview?.kind === 'text' && preview.textContent !== null ? (
          <div className="flex h-full flex-col">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <FileCode className="h-3.5 w-3.5 text-amber-500" />
                {isEditing ? 'Édition à chaud' : 'Aperçu texte / code'}
                {isEditing && draftText !== preview.textContent && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    Modifié
                  </span>
                )}
              </span>

              <div className="flex items-center gap-1.5">
                {preview.truncated && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    Tronqué à 256 Ko
                  </span>
                )}
                {canMutate && !preview.truncated && !isEditing && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftText(preview.textContent ?? '');
                      setIsEditing(true);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-300"
                  >
                    <Pencil className="h-3 w-3" />
                    Éditer à chaud
                  </button>
                )}
                {isEditing && (
                  <>
                    <button
                      type="button"
                      disabled={savingEdit}
                      onClick={() => setIsEditing(false)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-45 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <X className="h-3 w-3" />
                      Annuler
                    </button>
                    <button
                      type="button"
                      disabled={savingEdit}
                      onClick={handleSaveEdit}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-45"
                      title="Ctrl+S"
                    >
                      {savingEdit ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                      Enregistrer
                    </button>
                  </>
                )}
              </div>
            </div>

            {isEditing ? (
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    handleSaveEdit();
                  } else if (e.key === 'Escape') {
                    setIsEditing(false);
                  }
                }}
                spellCheck={false}
                className="flex-1 resize-none rounded-xl border border-amber-400 bg-white p-3 font-mono text-[11.5px] leading-relaxed text-slate-900 outline-none focus:ring-2 focus:ring-amber-500/20 dark:border-amber-500/60 dark:bg-slate-950 dark:text-slate-100"
              />
            ) : (
              <div className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11.5px] leading-relaxed dark:border-slate-800 dark:bg-slate-950">
                {preview.textContent.split('\n').map((line, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="w-8 shrink-0 text-right text-slate-400 select-none dark:text-slate-600">
                      {i + 1}
                    </span>
                    <span className="break-all whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : preview?.kind === 'binary' && preview.hexDump ? (
          <div className="flex h-full flex-col">
            <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Binary className="h-3.5 w-3.5 text-violet-500" />
                Inspecteur Hexadécimal (256 premiers octets)
              </span>
            </div>
            <pre className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300 dark:border-slate-800">
              {preview.hexDump}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
