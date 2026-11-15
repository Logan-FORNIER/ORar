import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { IntegrityReport } from '../types';

interface IntegrityModalProps {
  report: IntegrityReport | null;
  onClose: () => void;
}

export function IntegrityModal({ report, onClose }: IntegrityModalProps) {
  if (!report) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                report.valid
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}
            >
              {report.valid ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <ShieldAlert className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Rapport d'intégrité ({report.format})
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Vérification complète sans extraction sur disque
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

        <div className="space-y-4 px-5 py-4 text-xs">
          <div
            className={`rounded-xl border p-3.5 ${
              report.valid
                ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200'
                : 'border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200'
            }`}
          >
            <div className="font-semibold">
              {report.valid ? 'Archive intacte et vérifiée' : 'Erreurs d’intégrité détectées'}
            </div>
            <p className="mt-1 opacity-90">{report.message}</p>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Fichiers testés</div>
              <div className="mt-0.5 text-base font-bold text-slate-900 tabular-nums dark:text-slate-100">
                {report.checkedFiles}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Durée</div>
              <div className="mt-0.5 text-base font-bold text-slate-900 tabular-nums dark:text-slate-100">
                {report.durationMs} ms
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Manifeste SHA-256</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {report.manifestVerified === null
                  ? 'N/A'
                  : report.manifestVerified
                    ? 'Valide'
                    : 'Invalide'}
              </div>
            </div>
          </div>

          {report.sha256Manifest && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Empreinte SHA-256 du manifeste
              </div>
              <div className="font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">
                {report.sha256Manifest}
              </div>
            </div>
          )}

          {report.failedFiles.length > 0 && (
            <div>
              <div className="mb-1.5 font-semibold text-rose-600 dark:text-rose-400">
                Entrées en échec ({report.failedFiles.length})
              </div>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50/50 p-2 font-mono text-[11px] text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                {report.failedFiles.map((item, idx) => (
                  <div key={idx}>{item}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
