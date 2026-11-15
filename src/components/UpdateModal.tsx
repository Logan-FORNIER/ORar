import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  RefreshCw,
  Tag,
  Terminal,
  X,
} from 'lucide-react';
import { AppUpdateInfo } from '../types';
import { formatBytes } from '../utils';

interface UpdateModalProps {
  isOpen: boolean;
  info: AppUpdateInfo | null;
  checking: boolean;
  installing: boolean;
  error: string | null;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onOpenReleases: () => void;
}

export function UpdateModal({
  isOpen,
  info,
  checking,
  installing,
  error,
  onClose,
  onCheck,
  onInstall,
  onOpenReleases,
}: UpdateModalProps) {
  if (!isOpen) return null;

  const hasUpdate = Boolean(info?.updateAvailable);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-xs">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                hasUpdate
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
              }`}
            >
              <ArrowUpCircle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Mises à jour ORar &amp; Releases GitHub
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Version installée :{' '}
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  v{info?.currentVersion ?? '0.1.0'}
                </span>
                {info && (
                  <>
                    {' '}
                    • Dernière release :{' '}
                    <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                      {info.tagName}
                    </span>
                  </>
                )}
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

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200">
              {error}
            </div>
          )}

          {checking && !info ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
              <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />
              Interrogation de GitHub Releases en cours...
            </div>
          ) : info ? (
            <>
              <div
                className={`rounded-xl border p-3.5 ${
                  hasUpdate
                    ? 'border-amber-300 bg-amber-50/70 dark:border-amber-800/60 dark:bg-amber-950/25'
                    : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/20'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    {hasUpdate ? (
                      <>
                        <Tag className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <span className="text-amber-900 dark:text-amber-200">
                          Nouvelle version disponible : {info.releaseName}
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-emerald-900 dark:text-emerald-200">
                          {info.releaseName === 'Aucune release publiée pour le moment'
                            ? info.releaseName
                            : `ORar est à jour (${info.tagName})`}
                        </span>
                      </>
                    )}
                  </div>
                  {info.publishedAt && (
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">
                      {new Date(info.publishedAt).toLocaleDateString('fr-FR')}
                    </span>
                  )}
                </div>

                {info.installerName && (
                  <p className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                    Installeur détecté :{' '}
                    <code className="font-mono font-medium">{info.installerName}</code>
                    {info.installerSize ? ` (${formatBytes(info.installerSize)})` : ''}
                  </p>
                )}
              </div>

              <div>
                <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  Notes de version
                </div>
                <pre className="max-h-52 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                  {info.releaseNotes.trim() || 'Aucune note de version fournie.'}
                </pre>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-slate-500 dark:border-slate-800 dark:text-slate-400">
              Cliquez sur « Vérifier maintenant » pour consulter les dernières releases de ORar sur
              GitHub.
            </div>
          )}

          {/* Developer Tagging Quick Reminder */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-950/60">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              <Terminal className="h-3.5 w-3.5 text-indigo-500" />
              Publication d’une nouvelle version (Tags Git)
            </div>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Exécute{' '}
              <code className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                npm run release -- patch
              </code>{' '}
              (ou <code className="font-mono text-[10px]">minor</code> /{' '}
              <code className="font-mono text-[10px]">major</code>) pour incrémenter la version,
              créer le tag <code className="font-mono text-[10px]">v*</code> et lancer le build
              automatique de l’installeur sur GitHub Actions.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/80 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/70">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={checking || installing}
              onClick={onCheck}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              Vérifier maintenant
            </button>

            <button
              type="button"
              onClick={onOpenReleases}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
              GitHub Releases
            </button>
          </div>

          <div className="flex items-center gap-2">
            {info?.installerUrl && (
              <button
                type="button"
                disabled={installing || checking}
                onClick={onInstall}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs disabled:opacity-45 ${
                  hasUpdate
                    ? 'bg-amber-500 hover:bg-amber-600'
                    : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                <Download className="h-3.5 w-3.5" />
                {installing ? 'Téléchargement...' : 'Télécharger & Installer'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Fermer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
