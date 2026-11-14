"use client";

import React, { useRef, useState } from "react";
import { FolderOpen, FileUp, Package, Trash2, ShieldCheck, FileText } from "lucide-react";
import {
  DirectoryScanSummary,
  isDirectoryPickerSupported,
  packageSummaryAsZip,
  pickDirectoryNative,
  scanFileList,
} from "@/lib/fs/local-fs";
import { CornerReticles } from "./MorphStatusIcon";

interface FileSelectorPanelProps {
  summary: DirectoryScanSummary | null;
  onSummaryChange: (summary: DirectoryScanSummary | null) => void;
  onSendZip?: (blob: Blob, filename: string, sha256: string) => Promise<void>;
  canSendP2P: boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 octets";
  const units = ["octets", "Ko", "Mo", "Go"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${idx === 0 ? val : val.toFixed(2)} ${units[idx]}`;
}

export default function FileSelectorPanel({
  summary,
  onSummaryChange,
  onSendZip,
  canSendP2P,
}: FileSelectorPanelProps) {
  const dirInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zipHash, setZipHash] = useState<string | null>(null);

  const handleSelectDirectory = async () => {
    setError(null);
    setZipHash(null);
    if (isDirectoryPickerSupported()) {
      try {
        setBusy(true);
        const result = await pickDirectoryNative();
        onSummaryChange(result);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        // Fallback to webkitdirectory input if File System Access API fails in context
      } finally {
        setBusy(false);
      }
    }
    dirInputRef.current?.click();
  };

  const handleFallbackDirChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setError(null);
    setZipHash(null);
    onSummaryChange(scanFileList(e.target.files, "webkitdirectory"));
    e.target.value = "";
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setError(null);
    setZipHash(null);
    onSummaryChange(scanFileList(e.target.files, "filePicker"));
    e.target.value = "";
  };

  const handleSendBundle = async () => {
    if (!summary || !onSendZip) return;
    try {
      setBusy(true);
      setError(null);
      const { blob, filename, sha256 } = await packageSummaryAsZip(summary);
      setZipHash(sha256);
      await onSendZip(blob, filename, sha256);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'envoi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sd-surface rounded-2xl p-5 flex flex-col gap-4 h-full">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-white/[0.07]">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-orange-500/15 border border-orange-500/30 font-mono text-[10px] font-bold text-orange-300">
              01
            </span>
            <h2 className="text-sm font-semibold tracking-tight text-zinc-100">
              Source Locale Réelle
            </h2>
          </div>
          <p className="font-mono text-[11px] text-zinc-400 tabular-nums">
            {summary
              ? `${summary.files.length} fichier(s) · ${formatBytes(summary.totalBytes)} · ${summary.folderCount} dossier(s) [${summary.sourceMode}]`
              : "0 fichiers · 0 octets · 0 dossiers — En attente de sélection locale"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleSelectDirectory}
            className="sd-btn inline-flex items-center gap-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 px-3 py-2 text-xs font-medium text-white shadow-sm shadow-orange-950/50"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Sélectionner un dossier
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="sd-btn inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-50 px-3 py-2 text-xs font-medium text-zinc-200"
          >
            <FileUp className="w-3.5 h-3.5" />
            Fichiers
          </button>
          {summary && (
            <button
              type="button"
              onClick={() => {
                onSummaryChange(null);
                setZipHash(null);
                setError(null);
              }}
              className="sd-btn inline-flex items-center gap-1 rounded-xl border border-white/10 bg-transparent hover:bg-red-950/30 hover:border-red-500/30 px-2.5 py-2 text-xs text-zinc-400 hover:text-red-300"
              title="Réinitialiser l'état vide"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Vider
            </button>
          )}
        </div>
      </div>

      {/* Mandatory webkitdirectory fallback + standard file input */}
      <input
        ref={dirInputRef}
        type="file"
        className="hidden"
        // @ts-expect-error non-standard webkitdirectory attribute for universal browser fallback
        webkitdirectory=""
        multiple
        onChange={handleFallbackDirChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={handleFileInputChange}
      />

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {!summary ? (
        <div className="relative sd-subsurface rounded-xl border-dashed border-white/15 p-8 text-center flex-1 flex flex-col items-center justify-center min-h-[260px]">
          <CornerReticles tone="orange" />
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-400">
            <FolderOpen className="w-6 h-6" />
          </div>
          <p className="text-sm font-medium text-zinc-200">État initial vide</p>
          <p className="text-xs text-zinc-400 mt-1.5 max-w-sm leading-relaxed">
            Aucune donnée fictive n&apos;est chargée. Sélectionnez un dossier local via{" "}
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
              window.showDirectoryPicker()
            </code>{" "}
            (ou fallback{" "}
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
              webkitdirectory
            </code>
            ) pour analyser vos fichiers réels.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 flex-1">
          <div className="sd-subsurface flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5">
            <div className="text-xs text-zinc-400">
              Racine :{" "}
              <span className="font-mono font-semibold text-zinc-100">{summary.rootName}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(summary.extensionCounts)
                .slice(0, 6)
                .map(([ext, count]) => (
                  <span
                    key={ext}
                    className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-300 tabular-nums"
                  >
                    .{ext} · {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="sd-subsurface sd-scroll max-h-64 flex-1 overflow-y-auto rounded-xl divide-y divide-white/[0.05]">
            {summary.files.slice(0, 100).map((f) => (
              <div
                key={f.relativePath}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="font-mono text-zinc-200 truncate">{f.relativePath}</span>
                </div>
                <span className="font-mono text-[11px] text-zinc-400 shrink-0 tabular-nums">
                  {formatBytes(f.size)}
                </span>
              </div>
            ))}
            {summary.files.length > 100 && (
              <div className="px-3 py-2 text-xs text-zinc-500 font-mono">
                … et {summary.files.length - 100} autre(s) fichier(s)
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/[0.07]">
            {zipHash ? (
              <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                SHA-256: {zipHash.slice(0, 18)}…
              </div>
            ) : (
              <span className="text-[11px] text-zinc-400">
                ZIP + SHA-256 calculés à la volée avant chiffrement AES-256-GCM
              </span>
            )}

            <button
              type="button"
              disabled={!canSendP2P || busy || summary.files.length === 0}
              onClick={handleSendBundle}
              className="sd-btn w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2.5 text-xs font-semibold text-white shadow-sm shadow-emerald-950/50"
            >
              <Package className="w-4 h-4" />
              {busy ? "Empaquetage / Envoi…" : "Envoyer via WebRTC chiffré"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
