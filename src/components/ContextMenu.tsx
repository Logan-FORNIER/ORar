import { useEffect } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  Fingerprint,
  Pencil,
  Trash2,
} from 'lucide-react';
import { ArchiveEntry } from '../types';

interface ContextMenuProps {
  x: number;
  y: number;
  entry: ArchiveEntry | null;
  canMutate: boolean;
  onClose: () => void;
  onPreview: (entry: ArchiveEntry) => void;
  onOpenExternal: (entry: ArchiveEntry) => void;
  onExtractOne: (entry: ArchiveEntry) => void;
  onRename: (entry: ArchiveEntry) => void;
  onComputeHashes: (entry: ArchiveEntry) => void;
  onCopyPath: (entry: ArchiveEntry) => void;
  onDelete: (entry: ArchiveEntry) => void;
}

export function ContextMenu({
  x,
  y,
  entry,
  canMutate,
  onClose,
  onPreview,
  onOpenExternal,
  onExtractOne,
  onRename,
  onComputeHashes,
  onCopyPath,
  onDelete,
}: ContextMenuProps) {
  useEffect(() => {
    if (!entry) return;
    const handleClick = () => onClose();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [entry, onClose]);

  if (!entry) return null;

  const clampedX = Math.min(x, window.innerWidth - 250);
  const clampedY = Math.min(y, window.innerHeight - 280);

  return (
    <div
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 text-xs shadow-2xl dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="mb-1 truncate border-b border-slate-100 px-2.5 py-1.5 font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
        {entry.name}
      </div>

      {!entry.isDir && (
        <>
          <MenuButton
            icon={<Eye className="h-3.5 w-3.5 text-amber-500" />}
            label="Aperçu instantané"
            onClick={() => {
              onPreview(entry);
              onClose();
            }}
          />
          <MenuButton
            icon={<ExternalLink className="h-3.5 w-3.5 text-indigo-500" />}
            label="Ouvrir dans Windows"
            onClick={() => {
              onOpenExternal(entry);
              onClose();
            }}
          />
        </>
      )}

      <MenuButton
        icon={<Download className="h-3.5 w-3.5 text-emerald-500" />}
        label="Extraire cet élément..."
        onClick={() => {
          onExtractOne(entry);
          onClose();
        }}
      />

      {!entry.isDir && (
        <MenuButton
          icon={<Fingerprint className="h-3.5 w-3.5 text-violet-500" />}
          label="Calculer Hashes (MD5/SHA)"
          onClick={() => {
            onComputeHashes(entry);
            onClose();
          }}
        />
      )}

      <MenuButton
        icon={<Copy className="h-3.5 w-3.5 text-slate-400" />}
        label="Copier le chemin interne"
        onClick={() => {
          onCopyPath(entry);
          onClose();
        }}
      />

      {canMutate && (
        <>
          <div className="my-1 h-px bg-slate-100 dark:bg-slate-800" />
          <MenuButton
            icon={<Pencil className="h-3.5 w-3.5 text-sky-500" />}
            label="Renommer"
            shortcut="F2"
            onClick={() => {
              onRename(entry);
              onClose();
            }}
          />
          <MenuButton
            icon={<Trash2 className="h-3.5 w-3.5 text-rose-500" />}
            label="Supprimer de l'archive"
            shortcut="Suppr"
            danger
            onClick={() => {
              onDelete(entry);
              onClose();
            }}
          />
        </>
      )}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition ${
        danger
          ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon}
        <span>{label}</span>
      </span>
      {shortcut && <span className="font-mono text-[10px] text-slate-400">{shortcut}</span>}
    </button>
  );
}
