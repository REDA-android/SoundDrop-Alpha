import { deflateSync, inflateSync } from "fflate";
import {
  EncryptedSession,
  EphemeralKeyPair,
  deriveEncryptedSession,
  generateEphemeralKeyPair,
} from "../crypto/session";
import { sha256Hex } from "../fs/local-fs";

export interface OfflineSignalPayload {
  sdp: RTCSessionDescriptionInit;
  ecdhPub: string;
}

function encodeToken(prefix: "SDO1:" | "SDA1:", payload: OfflineSignalPayload): string {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = deflateSync(json, { level: 9 });
  let bin = "";
  for (let i = 0; i < compressed.length; i++) {
    bin += String.fromCharCode(compressed[i]);
  }
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${b64}`;
}

export function decodeToken(token: string): {
  kind: "offer" | "answer";
  payload: OfflineSignalPayload;
} {
  const trimmed = token.trim();
  let kind: "offer" | "answer";
  let rawB64: string;
  if (trimmed.startsWith("SDO1:")) {
    kind = "offer";
    rawB64 = trimmed.slice(5);
  } else if (trimmed.startsWith("SDA1:")) {
    kind = "answer";
    rawB64 = trimmed.slice(5);
  } else {
    throw new Error("Jeton SDP invalide (doit commencer par SDO1: ou SDA1:)");
  }
  const padded = rawB64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((rawB64.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const json = new TextDecoder().decode(inflateSync(bytes));
  return { kind, payload: JSON.parse(json) as OfflineSignalPayload };
}

export interface TransferProgress {
  filename: string;
  bytesTransferred: number;
  totalBytes: number;
  sha256?: string;
}

export interface ReceivedFile {
  filename: string;
  size: number;
  sha256: string;
  blob: Blob;
  verified: boolean;
}

type ControlMsg =
  | { type: "file-meta"; filename: string; totalBytes: number; sha256: string; totalChunks: number }
  | { type: "file-done"; sha256: string };

const CHUNK_SIZE = 32 * 1024; // 32 KB chunks (safe for all SCTP implementations + AES-GCM overhead)

export class SoundDropPeer {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private keypair: EphemeralKeyPair | null = null;
  private session: EncryptedSession | null = null;

  private incomingMeta: {
    filename: string;
    totalBytes: number;
    sha256: string;
    totalChunks: number;
  } | null = null;
  private incomingChunks: Uint8Array[] = [];
  private incomingBytes = 0;

  constructor(
    private callbacks: {
      onStateChange: (state: RTCPeerConnectionState) => void;
      onChannelOpen: (sasCode: string) => void;
      onProgress: (progress: TransferProgress) => void;
      onFileReceived: (file: ReceivedFile) => void;
      onError: (err: string) => void;
    }
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.pc.onconnectionstatechange = () => {
      this.callbacks.onStateChange(this.pc.connectionState);
    };

    this.pc.ondatachannel = (ev) => {
      this.attachDataChannel(ev.channel);
    };
  }

  private async waitForIceGathering(timeoutMs = 2500): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onState = () => {
        if (this.pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          this.pc.removeEventListener("icegatheringstatechange", onState);
          resolve();
        }
      };
      this.pc.addEventListener("icegatheringstatechange", onState);
    });
  }

  private attachDataChannel(channel: RTCDataChannel) {
    this.dc = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;

    channel.onopen = () => {
      if (this.session) {
        this.callbacks.onChannelOpen(this.session.sasCode);
      }
    };

    channel.onmessage = async (ev) => {
      try {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data) as ControlMsg;
          if (msg.type === "file-meta") {
            this.incomingMeta = msg;
            this.incomingChunks = [];
            this.incomingBytes = 0;
            this.callbacks.onProgress({
              filename: msg.filename,
              bytesTransferred: 0,
              totalBytes: msg.totalBytes,
            });
          } else if (msg.type === "file-done" && this.incomingMeta) {
            const totalLen = this.incomingChunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const c of this.incomingChunks) {
              merged.set(c, offset);
              offset += c.length;
            }
            const actualSha = await sha256Hex(merged);
            const verified = actualSha === this.incomingMeta.sha256;
            const blob = new Blob([merged], { type: "application/octet-stream" });
            this.callbacks.onFileReceived({
              filename: this.incomingMeta.filename,
              size: merged.length,
              sha256: actualSha,
              blob,
              verified,
            });
            this.incomingMeta = null;
            this.incomingChunks = [];
          }
          return;
        }

        if (ev.data instanceof ArrayBuffer && this.session && this.incomingMeta) {
          const decrypted = await this.session.decrypt(new Uint8Array(ev.data));
          this.incomingChunks.push(decrypted);
          this.incomingBytes += decrypted.length;
          this.callbacks.onProgress({
            filename: this.incomingMeta.filename,
            bytesTransferred: this.incomingBytes,
            totalBytes: this.incomingMeta.totalBytes,
          });
        }
      } catch (err) {
        this.callbacks.onError(err instanceof Error ? err.message : "Erreur de réception DataChannel");
      }
    };
  }

  async createOfferToken(): Promise<string> {
    this.keypair = await generateEphemeralKeyPair();
    const channel = this.pc.createDataChannel("sounddrop-sd1", { ordered: true });
    this.attachDataChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();

    return encodeToken("SDO1:", {
      sdp: this.pc.localDescription!,
      ecdhPub: this.keypair.publicKeyB64,
    });
  }

  async acceptOfferAndCreateAnswer(offerToken: string): Promise<string> {
    const decoded = decodeToken(offerToken);
    if (decoded.kind !== "offer") {
      throw new Error("Ce jeton n'est pas une offre SDO1.");
    }
    this.keypair = await generateEphemeralKeyPair();
    this.session = await deriveEncryptedSession(this.keypair.privateKey, decoded.payload.ecdhPub);

    await this.pc.setRemoteDescription(decoded.payload.sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGathering();

    return encodeToken("SDA1:", {
      sdp: this.pc.localDescription!,
      ecdhPub: this.keypair.publicKeyB64,
    });
  }

  async acceptAnswerToken(answerToken: string): Promise<void> {
    const decoded = decodeToken(answerToken);
    if (decoded.kind !== "answer") {
      throw new Error("Ce jeton n'est pas une réponse SDA1.");
    }
    if (!this.keypair) {
      throw new Error("Aucune offre locale active.");
    }
    this.session = await deriveEncryptedSession(this.keypair.privateKey, decoded.payload.ecdhPub);
    await this.pc.setRemoteDescription(decoded.payload.sdp);
  }

  async sendBlob(filename: string, blob: Blob): Promise<string> {
    if (!this.dc || this.dc.readyState !== "open" || !this.session) {
      throw new Error("Le canal WebRTC chiffré n'est pas ouvert.");
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await sha256Hex(buf);
    const totalChunks = Math.ceil(buf.length / CHUNK_SIZE);

    const meta: ControlMsg = {
      type: "file-meta",
      filename,
      totalBytes: buf.length,
      sha256,
      totalChunks,
    };
    this.dc.send(JSON.stringify(meta));

    for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
      if (this.dc.bufferedAmount > 512 * 1024) {
        await new Promise<void>((resolve) => {
          const dc = this.dc!;
          const onLow = () => {
            dc.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          dc.addEventListener("bufferedamountlow", onLow);
        });
      }
      const chunk = buf.subarray(offset, Math.min(offset + CHUNK_SIZE, buf.length));
      const encrypted = await this.session.encrypt(chunk);
      this.dc.send(new Uint8Array(encrypted));

      this.callbacks.onProgress({
        filename,
        bytesTransferred: Math.min(offset + CHUNK_SIZE, buf.length),
        totalBytes: buf.length,
        sha256,
      });
    }

    this.dc.send(JSON.stringify({ type: "file-done", sha256 } satisfies ControlMsg));
    return sha256;
  }

  close() {
    this.dc?.close();
    this.pc.close();
  }
}
