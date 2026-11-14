"use client";

import React, { useEffect, useRef, useState } from "react";
import { Radio, Mic, MicOff, Volume2, Download, Upload, AlertTriangle } from "lucide-react";
import {
  AcousticIoError,
  RxListenerHandle,
  startAcousticReceiver,
  transmitAcousticFrame,
} from "@/lib/acoustic/audio-io";
import { decodeWav, demodulateFrame, encodeWav48k, modulateFrame } from "@/lib/acoustic/modem";
import { AcousticProfile } from "@/lib/acoustic/protocol";
import { AcousticSpectrum } from "./MorphStatusIcon";

interface DecodedLogItem {
  id: string;
  timestamp: string;
  text: string;
  snrDb: number;
  correlation: number;
  source: "micro" | "wav";
}

interface AcousticModemPanelProps {
  onRoomCodeDetected?: (roomCode: string) => void;
  externalTxText?: string;
}

const PROFILE_META: Record<AcousticProfile, string> = {
  audible: "1.2–4.2 kHz",
  fast: "1.6–7.8 kHz",
  ultrasonic: "17.5–19.8 kHz",
};

export default function AcousticModemPanel({
  onRoomCodeDetected,
  externalTxText,
}: AcousticModemPanelProps) {
  const [profile, setProfile] = useState<AcousticProfile>("audible");
  const [txText, setTxText] = useState("");
  const [txBusy, setTxBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [rms, setRms] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<DecodedLogItem[]>([]);

  const rxHandleRef = useRef<RxListenerHandle | null>(null);
  const wavInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (externalTxText) {
      setTxText(externalTxText);
    }
  }, [externalTxText]);

  useEffect(() => {
    return () => {
      rxHandleRef.current?.stop();
    };
  }, []);

  const appendDecoded = (text: string, snrDb: number, correlation: number, source: "micro" | "wav") => {
    setLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString(),
        text,
        snrDb,
        correlation,
        source,
      },
      ...prev.slice(0, 19),
    ]);
    if (text.startsWith("SD1-ROOM:") && onRoomCodeDetected) {
      onRoomCodeDetected(text.slice("SD1-ROOM:".length).trim());
    }
  };

  const handleTransmit = async () => {
    if (!txText.trim()) return;
    try {
      setTxBusy(true);
      setError(null);
      const payload = new TextEncoder().encode(txText.trim());
      await transmitAcousticFrame({ flags: 0, payload }, profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur d'émission audio");
    } finally {
      setTxBusy(false);
    }
  };

  const handleToggleRx = async () => {
    if (listening) {
      await rxHandleRef.current?.stop();
      rxHandleRef.current = null;
      setListening(false);
      setRms(0);
      return;
    }

    try {
      setError(null);
      const handle = await startAcousticReceiver({
        profile,
        onRms: (val) => setRms(val),
        onFrame: (res) => {
          const text = new TextDecoder().decode(res.frame.payload);
          appendDecoded(text, res.snrDb, res.correlation, "micro");
        },
        onDecodeError: (msg) => {
          setError(`Décodage : ${msg}`);
        },
      });
      rxHandleRef.current = handle;
      setListening(true);
    } catch (err) {
      if (err instanceof AcousticIoError) {
        setError(`[${err.code}] ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : "Impossible d'ouvrir le microphone");
      }
      setListening(false);
    }
  };

  const handleExportWav = () => {
    if (!txText.trim()) return;
    try {
      setError(null);
      const payload = new TextEncoder().encode(txText.trim());
      const samples = modulateFrame({ flags: 0, payload }, profile);
      const wavBytes = encodeWav48k(samples);
      const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sounddrop-sd1-${profile}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur export WAV");
    }
  };

  const handleImportWav = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      setError(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { samples } = decodeWav(bytes);
      const res = demodulateFrame(samples, profile);
      const text = new TextDecoder().decode(res.frame.payload);
      appendDecoded(text, res.snrDb, res.correlation, "wav");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de décoder ce fichier WAV");
    }
  };

  return (
    <section className="sd-surface rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-white/[0.07]">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-orange-500/15 border border-orange-500/30 font-mono text-[10px] font-bold text-orange-300">
              03
            </span>
            <h2 className="text-sm font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
              <Radio className="w-4 h-4 text-orange-400" />
              Modem Acoustique Unifié SD1
            </h2>
          </div>
          <p className="text-[11px] text-zinc-400">
            16-FSK + Chirp Sync · Compatible{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-zinc-200">
              sounddrop_cli
            </code>{" "}
            · AudioWorklet sans larsen · CRC-32
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-xl bg-black/60 border border-white/[0.08] p-1">
          {(["audible", "fast", "ultrasonic"] as AcousticProfile[]).map((p) => (
            <button
              key={p}
              type="button"
              disabled={listening}
              onClick={() => setProfile(p)}
              title={`${p} (${PROFILE_META[p]})`}
              className={`sd-btn rounded-lg px-2.5 py-1 text-[11px] font-mono ${
                profile === p
                  ? "bg-orange-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-950/35 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* TX Panel */}
        <div className="sd-subsurface rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-zinc-200">
              Émission sonore
            </label>
            <span className="font-mono text-[10px] text-zinc-500">
              {PROFILE_META[profile]} · max 512 o
            </span>
          </div>
          <input
            type="text"
            value={txText}
            onChange={(e) => setTxText(e.target.value)}
            placeholder="Message ou SD1-ROOM:XXXXXX…"
            className="w-full rounded-xl border border-white/10 bg-black/60 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:border-orange-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={txBusy || !txText.trim()}
              onClick={handleTransmit}
              className="sd-btn inline-flex items-center gap-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-white"
            >
              <Volume2 className="w-3.5 h-3.5" />
              {txBusy ? "Émission…" : "Émettre par haut-parleur"}
            </button>
            <button
              type="button"
              disabled={!txText.trim()}
              onClick={handleExportWav}
              className="sd-btn inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 px-3 py-2 text-xs text-zinc-200"
              title="Générer un .wav 48 kHz compatible avec sounddrop_cli decode-wav"
            >
              <Download className="w-3.5 h-3.5" />
              Exporter .WAV
            </button>
          </div>
        </div>

        {/* RX Panel */}
        <div className="sd-subsurface rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-200">
              Réception (AudioWorklet)
            </span>
            <div className="flex items-center gap-2">
              <AcousticSpectrum rms={rms} active={listening} />
              <span className="font-mono text-[10px] text-zinc-400 tabular-nums w-16 text-right">
                {rms.toFixed(4)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleToggleRx}
              className={`sd-btn inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium text-white ${
                listening
                  ? "bg-red-600 hover:bg-red-500"
                  : "bg-emerald-600 hover:bg-emerald-500"
              }`}
            >
              {listening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              {listening ? "Arrêter l'écoute" : "Écouter (Microphone)"}
            </button>

            <button
              type="button"
              onClick={() => wavInputRef.current?.click()}
              className="sd-btn inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] px-3 py-2 text-xs text-zinc-200"
              title="Décoder un .wav généré par sounddrop_cli encode-wav"
            >
              <Upload className="w-3.5 h-3.5" />
              Décoder .WAV
            </button>
            <input
              ref={wavInputRef}
              type="file"
              accept=".wav,audio/wav"
              className="hidden"
              onChange={handleImportWav}
            />
          </div>
        </div>
      </div>

      {/* Real decoded log (starts empty) */}
      <div className="sd-subsurface rounded-xl p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-300">
            Trames SD1 décodées
          </span>
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
            {logs.length} trame(s)
          </span>
        </div>
        {logs.length === 0 ? (
          <p className="text-xs text-zinc-500 py-1">
            Aucune trame reçue pour le moment. Écoutez via le microphone ou importez un fichier .wav.
          </p>
        ) : (
          <div className="sd-scroll space-y-1.5 max-h-40 overflow-y-auto">
            {logs.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/50 border border-white/[0.07] px-3 py-2 text-xs"
              >
                <span className="font-mono text-emerald-300 break-all">{item.text}</span>
                <span className="font-mono text-[10px] text-zinc-400 shrink-0 tabular-nums">
                  [{item.source}] SNR {item.snrDb.toFixed(1)} dB · corr {item.correlation.toFixed(2)} · {item.timestamp}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
