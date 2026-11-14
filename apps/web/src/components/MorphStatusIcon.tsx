"use client";

import React from "react";

interface AcousticSpectrumProps {
  rms: number;
  active: boolean;
}

/**
 * Real-time acoustic spectrum bars driven strictly by actual microphone RMS.
 * Remains completely flat at 0 when idle (no fake wave animation).
 */
export function AcousticSpectrum({ rms, active }: AcousticSpectrumProps) {
  const weights = [0.45, 0.72, 1.0, 0.86, 0.6, 0.92, 0.68, 0.4];
  const normalized = active ? Math.min(1, rms * 5.5) : 0;

  return (
    <div
      className="flex items-end gap-1 h-7 px-2 py-1 rounded-lg bg-black/50 border border-white/[0.06]"
      aria-label={active ? `Niveau audio RMS ${rms.toFixed(4)}` : "Microphone inactif"}
    >
      {weights.map((w, idx) => {
        const pct = active ? Math.max(12, Math.round(normalized * w * 100)) : 10;
        return (
          <span
            key={idx}
            className={`w-1 rounded-full transition-[height,background-color] duration-75 ${
              active
                ? normalized > 0.65
                  ? "bg-orange-400"
                  : "bg-emerald-400"
                : "bg-zinc-700"
            }`}
            style={{ height: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

interface CornerReticlesProps {
  tone?: "zinc" | "emerald" | "orange";
}

/** Hairline architectural corner brackets for precision dropzones & QR frames. */
export function CornerReticles({ tone = "zinc" }: CornerReticlesProps) {
  const color =
    tone === "emerald"
      ? "border-emerald-400/50"
      : tone === "orange"
        ? "border-orange-400/50"
        : "border-white/20";

  return (
    <>
      <span aria-hidden className={`pointer-events-none absolute top-2 left-2 h-2.5 w-2.5 border-t border-l ${color}`} />
      <span aria-hidden className={`pointer-events-none absolute top-2 right-2 h-2.5 w-2.5 border-t border-r ${color}`} />
      <span aria-hidden className={`pointer-events-none absolute bottom-2 left-2 h-2.5 w-2.5 border-b border-l ${color}`} />
      <span aria-hidden className={`pointer-events-none absolute bottom-2 right-2 h-2.5 w-2.5 border-b border-r ${color}`} />
    </>
  );
}
