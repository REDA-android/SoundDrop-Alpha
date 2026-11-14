"use client";

import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Link2,
  ShieldCheck,
  Radio,
  Copy,
  Check,
  Download,
  QrCode,
  WifiOff,
} from "lucide-react";
import { ReceivedFile, SoundDropPeer, TransferProgress } from "@/lib/webrtc/peer";
import { formatBytes } from "./FileSelectorPanel";

interface WebRtcPairingPanelProps {
  peerRef: React.MutableRefObject<SoundDropPeer | null>;
  connectionState: RTCPeerConnectionState;
  sasCode: string | null;
  progress: TransferProgress | null;
  receivedFiles: ReceivedFile[];
  detectedRoomCode: string | null;
  onEmitRoomAcoustic: (roomPayload: string) => void;
  onStateChange: (state: RTCPeerConnectionState) => void;
  onChannelOpen: (sas: string) => void;
  onProgress: (p: TransferProgress) => void;
  onFileReceived: (f: ReceivedFile) => void;
}

export default function WebRtcPairingPanel({
  peerRef,
  connectionState,
  sasCode,
  progress,
  receivedFiles,
  detectedRoomCode,
  onEmitRoomAcoustic,
  onStateChange,
  onChannelOpen,
  onProgress,
  onFileReceived,
}: WebRtcPairingPanelProps) {
  const [mode, setMode] = useState<"room" | "airgap">("room");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [offerToken, setOfferToken] = useState("");
  const [answerToken, setAnswerToken] = useState("");
  const [remoteTokenInput, setRemoteTokenInput] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (detectedRoomCode) {
      setJoinCode(detectedRoomCode);
      setMode("room");
    }
  }, [detectedRoomCode]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const initPeer = () => {
    peerRef.current?.close();
    const peer = new SoundDropPeer({
      onStateChange,
      onChannelOpen,
      onProgress,
      onFileReceived,
      onError: (err) => setError(err),
    });
    peerRef.current = peer;
    return peer;
  };

  const renderQr = async (token: string) => {
    try {
      const url = await QRCode.toDataURL(token, { width: 220, margin: 1 });
      setQrDataUrl(url);
    } catch {
      setQrDataUrl(null);
    }
  };

  const handleCreateRoom = async () => {
    try {
      setError(null);
      setStatusMsg("Création de l'offre WebRTC + clé ECDH P-256…");
      const peer = initPeer();
      const token = await peer.createOfferToken();
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      setRoomCode(code);
      setOfferToken(token);

      await fetch("/api/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: code, role: "offer", token }),
      });

      setStatusMsg(`Salon ${code} prêt. En attente du pair…`);
      onEmitRoomAcoustic(`SD1-ROOM:${code}`);

      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/signal?room=${encodeURIComponent(code)}`);
          const data = (await res.json()) as { entry?: { answer?: string } };
          if (data.entry?.answer) {
            clearInterval(pollTimerRef.current!);
            pollTimerRef.current = null;
            await peer.acceptAnswerToken(data.entry.answer);
            setStatusMsg("Réponse reçue, ouverture du DataChannel chiffré…");
          }
        } catch {
          // ignore transient poll errors
        }
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur de création du salon");
    }
  };

  const handleJoinRoom = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    try {
      setError(null);
      setStatusMsg(`Récupération de l'offre pour ${code}…`);
      const res = await fetch(`/api/signal?room=${encodeURIComponent(code)}`);
      const data = (await res.json()) as { entry?: { offer?: string } };
      if (!data.entry?.offer) {
        throw new Error(`Aucune offre trouvée pour le salon ${code}`);
      }
      const peer = initPeer();
      const answer = await peer.acceptOfferAndCreateAnswer(data.entry.offer);
      await fetch("/api/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: code, role: "answer", token: answer }),
      });
      setStatusMsg(`Connecté au salon ${code}. Négociation ICE en cours…`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur de connexion au salon");
    }
  };

  const handleCreateAirGapOffer = async () => {
    try {
      setError(null);
      const peer = initPeer();
      const token = await peer.createOfferToken();
      setOfferToken(token);
      setAnswerToken("");
      await renderQr(token);
      setStatusMsg("Offre SDO1 générée hors-ligne. Transférez-la au pair.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur offre hors-ligne");
    }
  };

  const handleAcceptAirGapToken = async () => {
    const raw = remoteTokenInput.trim();
    if (!raw) return;
    try {
      setError(null);
      if (raw.startsWith("SDO1:")) {
        const peer = initPeer();
        const ans = await peer.acceptOfferAndCreateAnswer(raw);
        setAnswerToken(ans);
        await renderQr(ans);
        setStatusMsg("Réponse SDA1 générée. Renvoyez-la à l'émetteur.");
      } else if (raw.startsWith("SDA1:")) {
        if (!peerRef.current) throw new Error("Créez d'abord une offre SDO1.");
        await peerRef.current.acceptAnswerToken(raw);
        setStatusMsg("Réponse SDA1 appliquée. Ouverture du tunnel WebRTC…");
      } else {
        throw new Error("Le jeton doit commencer par SDO1: ou SDA1:");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Jeton SDP invalide");
    }
  };

  const copyToken = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const activeToken = answerToken || offerToken;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Link2 className="w-4 h-4 text-emerald-400" />
            2. Appairage P2P WebRTC (Chiffrement AES-256-GCM + SAS)
          </h2>
          <p className="text-xs text-zinc-400">
            État : <span className="font-mono text-zinc-200">{connectionState}</span>
            {statusMsg && ` — ${statusMsg}`}
          </p>
        </div>

        <div className="flex items-center gap-1.5 rounded-xl bg-zinc-950 border border-zinc-800 p-1">
          <button
            type="button"
            onClick={() => setMode("room")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition ${
              mode === "room" ? "bg-emerald-600 text-white" : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            Salon + Son
          </button>
          <button
            type="button"
            onClick={() => setMode("airgap")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition ${
              mode === "airgap" ? "bg-emerald-600 text-white" : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            <WifiOff className="w-3.5 h-3.5" />
            Air-Gap SDP / QR
          </button>
        </div>
      </div>

      {sasCode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/30 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <div>
              <p className="text-xs font-semibold text-emerald-200">
                Tunnel E2E ECDH P-256 + AES-256-GCM actif
              </p>
              <p className="text-[11px] text-emerald-300/80">
                Vérifiez visuellement que les deux appareils affichent ce code SAS :
              </p>
            </div>
          </div>
          <div className="rounded-lg bg-zinc-950 border border-emerald-500/40 px-3 py-1 font-mono text-lg font-bold tracking-widest text-emerald-300">
            {sasCode.slice(0, 3)} {sasCode.slice(3)}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {mode === "room" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <div className="text-xs font-medium text-zinc-300">Émetteur : Créer un salon</div>
            <button
              type="button"
              onClick={handleCreateRoom}
              className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-medium text-white transition"
            >
              Générer salon + Préparer signal sonore
            </button>
            {roomCode && (
              <div className="flex items-center justify-between rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
                <span className="text-xs text-zinc-400">Code salon :</span>
                <span className="font-mono text-sm font-bold text-orange-400">{roomCode}</span>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <div className="text-xs font-medium text-zinc-300">Récepteur : Rejoindre un salon</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Code 6 car. (ou reçu par son)"
                className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-100 uppercase placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                disabled={!joinCode.trim()}
                onClick={handleJoinRoom}
                className="rounded-xl bg-zinc-100 hover:bg-white disabled:opacity-40 px-3.5 py-2 text-xs font-semibold text-zinc-950 transition"
              >
                Rejoindre
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <button
              type="button"
              onClick={handleCreateAirGapOffer}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2 text-xs font-medium text-white transition"
            >
              <QrCode className="w-3.5 h-3.5" />
              Générer Offre SDO1 hors-ligne
            </button>

            {activeToken && (
              <div className="space-y-2">
                {qrDataUrl && (
                  <img
                    src={qrDataUrl}
                    alt="QR Code SDP"
                    className="rounded-lg border border-zinc-700 bg-white p-1 w-40 h-40"
                  />
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={activeToken}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-mono text-zinc-300"
                  />
                  <button
                    type="button"
                    onClick={() => copyToken(activeToken)}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300 hover:text-white"
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <label className="block text-xs font-medium text-zinc-300">
              Coller le jeton du pair (SDO1: ou SDA1:)
            </label>
            <textarea
              rows={3}
              value={remoteTokenInput}
              onChange={(e) => setRemoteTokenInput(e.target.value)}
              placeholder="SDO1:... ou SDA1:..."
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              disabled={!remoteTokenInput.trim()}
              onClick={handleAcceptAirGapToken}
              className="rounded-xl bg-zinc-100 hover:bg-white disabled:opacity-40 px-3.5 py-2 text-xs font-semibold text-zinc-950 transition"
            >
              Appliquer le jeton
            </button>
          </div>
        </div>
      )}

      {progress && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="font-mono text-zinc-200">{progress.filename}</span>
            <span className="font-mono text-zinc-400">
              {formatBytes(progress.bytesTransferred)} / {formatBytes(progress.totalBytes)}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all duration-100"
              style={{
                width: `${
                  progress.totalBytes > 0
                    ? Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100))
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {receivedFiles.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300">
            Fichiers reçus ({receivedFiles.length})
          </div>
          {receivedFiles.map((rf, idx) => (
            <div
              key={`${rf.sha256}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs"
            >
              <div>
                <div className="font-mono text-zinc-100">{rf.filename}</div>
                <div className="font-mono text-[11px] text-zinc-400">
                  {formatBytes(rf.size)} · SHA-256: {rf.sha256.slice(0, 16)}…{" "}
                  {rf.verified ? (
                    <span className="text-emerald-400 font-semibold">[Vérifié]</span>
                  ) : (
                    <span className="text-red-400 font-semibold">[Échec hash]</span>
                  )}
                </div>
              </div>
              <a
                href={URL.createObjectURL(rf.blob)}
                download={rf.filename}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white"
              >
                <Download className="w-3.5 h-3.5" />
                Enregistrer
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
