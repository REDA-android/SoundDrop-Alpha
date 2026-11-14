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

  const rmsPercent = Math.min(100, Math.round(rms * 350));

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Radio className="w-4 h-4 text-orange-400" />
            Modem Acoustique Unifié SD1 (16-FSK + Chirp Sync)
          </h2>
          <p className="text-xs text-zinc-400">
            Protocole binaire identique au CLI Rust (<code className="text-zinc-300">sounddrop_cli</code>),
            AudioWorklet sans larsen, CRC-32 IEEE 802.3.
          </p>
        </div>

        <div className="flex items-center gap-1.5 rounded-xl bg-zinc-950 border border-zinc-800 p-1">
          {(["audible", "fast", "ultrasonic"] as AcousticProfile[]).map((p) => (
            <button
              key={p}
              type="button"
              disabled={listening}
              onClick={() => setProfile(p)}
              className={`rounded-lg px-2.5 py-1 text-xs font-mono transition ${
                profile === p
                  ? "bg-orange-600 text-white"
                  : "text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* TX Panel */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
          <label className="block text-xs font-medium text-zinc-300">
            Émission sonore (max 512 octets UTF-8)
          </label>
          <input
            type="text"
            value={txText}
            onChange={(e) => setTxText(e.target.value)}
            placeholder="Saisissez un message ou code SD1-ROOM:XXXXXX…"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-orange-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={txBusy || !txText.trim()}
              onClick={handleTransmit}
              className="inline-flex items-center gap-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-white transition"
            >
              <Volume2 className="w-3.5 h-3.5" />
              {txBusy ? "Émission…" : "Émettre par haut-parleur"}
            </button>
            <button
              type="button"
              disabled={!txText.trim()}
              onClick={handleExportWav}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 px-3 py-2 text-xs text-zinc-200 transition"
              title="Générer un .wav 48 kHz compatible avec sounddrop_cli decode-wav"
            >
              <Download className="w-3.5 h-3.5" />
              Exporter .WAV
            </button>
          </div>
        </div>

        {/* RX Panel */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-300">Réception acoustique (AudioWorklet)</span>
            <span className="font-mono text-[11px] text-zinc-400">RMS: {rms.toFixed(4)}</span>
          </div>

          <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-75"
              style={{ width: `${rmsPercent}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleRx}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium text-white transition ${
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
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs text-zinc-200 transition"
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
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        <div className="text-xs font-medium text-zinc-400 mb-2">
          Trames SD1 décodées ({logs.length})
        </div>
        {logs.length === 0 ? (
          <p className="text-xs text-zinc-600">
            Aucune trame reçue pour le moment. Écoutez via le microphone ou importez un fichier .wav.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {logs.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-xs"
              >
                <span className="font-mono text-emerald-300 break-all">{item.text}</span>
                <span className="font-mono text-[11px] text-zinc-500 shrink-0">
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
