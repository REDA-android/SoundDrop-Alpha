"use client";

import React, { useRef, useState } from "react";
import { Waves, Shield, Cpu } from "lucide-react";
import FileSelectorPanel from "@/components/FileSelectorPanel";
import WebRtcPairingPanel from "@/components/WebRtcPairingPanel";
import AcousticModemPanel from "@/components/AcousticModemPanel";
import { DirectoryScanSummary } from "@/lib/fs/local-fs";
import { ReceivedFile, SoundDropPeer, TransferProgress } from "@/lib/webrtc/peer";

export default function HomePage() {
  const [summary, setSummary] = useState<DirectoryScanSummary | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>("new");
  const [sasCode, setSasCode] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [detectedRoomCode, setDetectedRoomCode] = useState<string | null>(null);
  const [externalTxText, setExternalTxText] = useState<string>("");

  const peerRef = useRef<SoundDropPeer | null>(null);

  const handleSendZip = async (blob: Blob, filename: string) => {
    if (!peerRef.current) return;
    await peerRef.current.sendBlob(filename, blob);
  };

  const isConnected = connectionState === "connected" && sasCode !== null;

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-7 space-y-6">
      {/* Studio Hairline Header */}
      <header className="sd-surface rounded-2xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500/20 to-emerald-500/10 border border-orange-500/30 text-orange-400 shadow-inner">
            <Waves className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-zinc-100">
                SoundDrop Alpha
              </h1>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-300">
                SD1
              </span>
            </div>
            <p className="text-xs text-zinc-400">
              Protocole SD1 unifié (Rust CLI ↔ Web) · WebRTC E2E (ECDH P-256 + AES-256-GCM)
            </p>
          </div>
        </div>

        {/* Real-time pipeline telemetry badges */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/50 px-2.5 py-1 text-zinc-300">
            <Cpu className="w-3.5 h-3.5 text-orange-400" />
            48 kHz · 16-FSK
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
              isConnected
                ? "border-emerald-500/35 bg-emerald-950/35 text-emerald-300"
                : "border-white/[0.08] bg-black/50 text-zinc-400"
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            {isConnected ? `E2E Actif (${sasCode})` : "E2E En attente"}
          </span>
        </div>
      </header>

      {/* Responsive 12-column Studio Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <div className="lg:col-span-5 flex flex-col">
          <FileSelectorPanel
            summary={summary}
            onSummaryChange={setSummary}
            onSendZip={handleSendZip}
            canSendP2P={isConnected}
          />
        </div>

        <div className="lg:col-span-7 flex flex-col gap-5">
          <WebRtcPairingPanel
            peerRef={peerRef}
            connectionState={connectionState}
            sasCode={sasCode}
            progress={progress}
            receivedFiles={receivedFiles}
            detectedRoomCode={detectedRoomCode}
            onEmitRoomAcoustic={(payload) => setExternalTxText(payload)}
            onStateChange={setConnectionState}
            onChannelOpen={(sas) => setSasCode(sas)}
            onProgress={setProgress}
            onFileReceived={(rf) => setReceivedFiles((prev) => [rf, ...prev])}
          />

          <AcousticModemPanel
            externalTxText={externalTxText}
            onRoomCodeDetected={(code) => setDetectedRoomCode(code)}
          />
        </div>
      </div>
    </main>
  );
}
