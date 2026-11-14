import { DemodResult, demodulateFrame, findChirpOffset, modulateFrame, resampleTo48k } from "./modem";
import { AcousticProfile, SAMPLE_RATE, SD1Frame, getProfileParams } from "./protocol";

export type MicErrorCode =
  | "INSECURE_CONTEXT"
  | "PERMISSION_DENIED"
  | "NO_MICROPHONE"
  | "WORKLET_UNSUPPORTED"
  | "UNKNOWN";

export class AcousticIoError extends Error {
  constructor(public code: MicErrorCode, message: string) {
    super(message);
  }
}

export async function transmitAcousticFrame(
  frame: SD1Frame,
  profile: AcousticProfile
): Promise<{ durationSec: number; sampleCount: number }> {
  const samples = modulateFrame(frame, profile);
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    return {
      durationSec: samples.length / SAMPLE_RATE,
      sampleCount: samples.length,
    };
  } finally {
    await ctx.close();
  }
}

export interface RxListenerHandle {
  stop: () => Promise<void>;
}

export async function startAcousticReceiver(options: {
  profile: AcousticProfile;
  onRms: (rms: number) => void;
  onFrame: (result: DemodResult) => void;
  onDecodeError?: (err: string) => void;
}): Promise<RxListenerHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new AcousticIoError(
      "INSECURE_CONTEXT",
      "L'accès au microphone nécessite un contexte sécurisé (HTTPS ou localhost)."
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw new AcousticIoError(
        "PERMISSION_DENIED",
        "Permission microphone refusée. Autorisez le microphone dans les paramètres du navigateur."
      );
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw new AcousticIoError("NO_MICROPHONE", "Aucun microphone détecté sur cet appareil.");
    }
    throw new AcousticIoError(
      "UNKNOWN",
      err instanceof Error ? err.message : "Erreur inconnue lors de l'accès au microphone."
    );
  }

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });

  if (!ctx.audioWorklet) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw new AcousticIoError(
      "WORKLET_UNSUPPORTED",
      "AudioWorklet n'est pas supporté par ce navigateur."
    );
  }

  await ctx.audioWorklet.addModule("/worklets/sounddrop-rx-processor.js");

  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "sounddrop-rx-processor");

  // IMPORTANT: Never connect worklet/source to ctx.destination (zero Larsen feedback)
  source.connect(worklet);

  const maxRingSamples = SAMPLE_RATE * 12; // 12s sliding window
  let ring = new Float32Array(0);
  let lastScanLen = 0;
  let stopped = false;
  const params = getProfileParams(options.profile);

  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (stopped) return;
    const rawChunk = event.data;
    const chunk = ctx.sampleRate === SAMPLE_RATE ? rawChunk : resampleTo48k(rawChunk, ctx.sampleRate);

    // Compute real RMS
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i++) {
      sumSq += chunk[i] * chunk[i];
    }
    options.onRms(Math.sqrt(sumSq / Math.max(1, chunk.length)));

    // Append to sliding ring buffer
    const merged = new Float32Array(Math.min(maxRingSamples, ring.length + chunk.length));
    if (ring.length + chunk.length <= maxRingSamples) {
      merged.set(ring, 0);
      merged.set(chunk, ring.length);
    } else {
      const keep = maxRingSamples - chunk.length;
      merged.set(ring.subarray(ring.length - keep), 0);
      merged.set(chunk, keep);
    }
    ring = merged;

    // Periodically scan for chirp + frame every ~0.25s of new audio
    if (ring.length - lastScanLen >= SAMPLE_RATE / 4 && ring.length >= params.chirpSamples * 2) {
      lastScanLen = ring.length;
      const sync = findChirpOffset(ring, params);
      if (sync) {
        try {
          const decoded = demodulateFrame(ring.subarray(sync.offset), options.profile);
          options.onFrame(decoded);
          // Consume processed audio past the chirp
          const advance = sync.offset + params.chirpSamples + params.postChirpGapSamples;
          ring = ring.slice(Math.min(ring.length, advance));
          lastScanLen = ring.length;
        } catch (err) {
          // Might simply be waiting for remaining symbols to arrive; only report CRC/magic errors if buffer is long
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("truncated") && options.onDecodeError) {
            options.onDecodeError(msg);
          }
        }
      }
    }
  };

  return {
    stop: async () => {
      stopped = true;
      worklet.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
