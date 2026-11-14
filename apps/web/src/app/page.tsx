"use client";

import React, { useRef, useState } from "react";
import { Waves } from "lucide-react";
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

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600/15 border border-orange-500/30 text-orange-400">
            <Waves className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-zinc-100">
              SoundDrop Alpha
            </h1>
            <p className="text-xs text-zinc-400">
              Protocole SD1 unifié (Rust CLI ↔ Web) · WebRTC E2E (ECDH P-256 + AES-256-GCM)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
          <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1">
            48 kHz · 16-FSK + Chirp
          </span>
          <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1">
            Zéro Donnée Fictive
          </span>
        </div>
      </header>

      <FileSelectorPanel
        summary={summary}
        onSummaryChange={setSummary}
        onSendZip={handleSendZip}
        canSendP2P={connectionState === "connected" && sasCode !== null}
      />

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
    </main>
  );
}
