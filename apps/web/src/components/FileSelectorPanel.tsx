"use client";

import React, { useRef, useState } from "react";
import { FolderOpen, FileUp, Package, Trash2, ShieldCheck } from "lucide-react";
import {
  DirectoryScanSummary,
  isDirectoryPickerSupported,
  packageSummaryAsZip,
  pickDirectoryNative,
  scanFileList,
} from "@/lib/fs/local-fs";

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
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">
            1. Source Locale Réelle (File System Access API)
          </h2>
          <p className="text-xs text-zinc-400">
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
            className="inline-flex items-center gap-2 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-white transition"
          >
            <FolderOpen className="w-4 h-4" />
            Sélectionner un dossier
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-zinc-100 transition"
          >
            <FileUp className="w-4 h-4" />
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
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 transition"
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
        <div className="mb-3 rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {!summary ? (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-8 text-center">
          <FolderOpen className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
          <p className="text-sm font-medium text-zinc-300">État initial vide</p>
          <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
            Aucune donnée fictive n&apos;est chargée. Sélectionnez un dossier local via{" "}
            <code className="text-zinc-300">window.showDirectoryPicker()</code> (ou fallback{" "}
            <code className="text-zinc-300">webkitdirectory</code>) pour analyser les fichiers réels.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-950/70 border border-zinc-800 px-3.5 py-2.5">
            <div className="text-xs text-zinc-300">
              Racine : <span className="font-mono font-semibold text-zinc-100">{summary.rootName}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(summary.extensionCounts)
                .slice(0, 6)
                .map(([ext, count]) => (
                  <span
                    key={ext}
                    className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                  >
                    .{ext}: {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="max-h-44 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/50 divide-y divide-zinc-800/70">
            {summary.files.slice(0, 100).map((f) => (
              <div
                key={f.relativePath}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
              >
                <span className="font-mono text-zinc-300 truncate">{f.relativePath}</span>
                <span className="font-mono text-zinc-500 shrink-0">{formatBytes(f.size)}</span>
              </div>
            ))}
            {summary.files.length > 100 && (
              <div className="px-3 py-1.5 text-xs text-zinc-500">
                … et {summary.files.length - 100} autre(s) fichier(s)
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {zipHash ? (
              <div className="inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400">
                <ShieldCheck className="w-4 h-4" />
                SHA-256: {zipHash.slice(0, 20)}…
              </div>
            ) : (
              <span className="text-xs text-zinc-500">
                Empaquetage ZIP + SHA-256 calculé à la volée avant chiffrement AES-256-GCM
              </span>
            )}

            <button
              type="button"
              disabled={!canSendP2P || busy || summary.files.length === 0}
              onClick={handleSendBundle}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-white transition"
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
