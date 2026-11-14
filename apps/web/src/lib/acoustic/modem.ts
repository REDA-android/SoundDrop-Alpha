import {
  AcousticProfile,
  FRAME_MAGIC,
  FRAME_VERSION,
  HEADER_LEN,
  MAX_PAYLOAD_LEN,
  ProfileParams,
  SAMPLE_RATE,
  SD1Frame,
  TRAILER_LEN,
  decodeFrame,
  encodeFrame,
  getProfileParams,
} from "./protocol";

export interface DemodResult {
  frame: SD1Frame;
  snrDb: number;
  chirpOffset: number;
  correlation: number;
}

function tukeyEnvelope(i: number, len: number, taperFrac: number): number {
  const taper = Math.round(len * taperFrac);
  if (taper === 0) return 1.0;
  if (i < taper) {
    return 0.5 * (1.0 - Math.cos((Math.PI * i) / taper));
  }
  if (i >= len - taper) {
    const j = len - 1 - i;
    return 0.5 * (1.0 - Math.cos((Math.PI * j) / taper));
  }
  return 1.0;
}

export function generateChirp(params: ProfileParams): Float32Array {
  const n = params.chirpSamples;
  const duration = n / SAMPLE_RATE;
  const f0 = params.chirpStartHz;
  const f1 = params.chirpEndHz;
  const rate = (f1 - f0) / duration;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const phase = 2.0 * Math.PI * (f0 * t + 0.5 * rate * t * t);
    const env = tukeyEnvelope(i, n, 0.1);
    out[i] = 0.75 * env * Math.sin(phase);
  }
  return out;
}

export function modulateFrame(frame: SD1Frame, profile: AcousticProfile): Float32Array {
  const bytes = encodeFrame(frame);
  const params = getProfileParams(profile);
  const totalSymbols = bytes.length * 2;
  const symbolStride = params.symbolSamples + params.guardSamples;
  const totalSamples =
    params.leadSilenceSamples +
    params.chirpSamples +
    params.postChirpGapSamples +
    totalSymbols * symbolStride +
    params.trailSilenceSamples;

  const out = new Float32Array(totalSamples);
  let cursor = params.leadSilenceSamples;

  const chirp = generateChirp(params);
  out.set(chirp, cursor);
  cursor += params.chirpSamples + params.postChirpGapSamples;

  for (let bIdx = 0; bIdx < bytes.length; bIdx++) {
    const b = bytes[bIdx];
    const nibbles = [(b >> 4) & 0x0f, b & 0x0f];
    for (const nib of nibbles) {
      const freq = params.baseFreqHz + nib * params.toneSpacingHz;
      for (let i = 0; i < params.symbolSamples; i++) {
        const t = i / SAMPLE_RATE;
        const env = tukeyEnvelope(i, params.symbolSamples, 0.1);
        out[cursor + i] = 0.75 * env * Math.sin(2.0 * Math.PI * freq * t);
      }
      cursor += symbolStride;
    }
  }
  return out;
}

function goertzelPower(samples: Float32Array, start: number, len: number, freqHz: number): number {
  if (len <= 0) return 0;
  const omega = (2.0 * Math.PI * freqHz) / SAMPLE_RATE;
  const coeff = 2.0 * Math.cos(omega);
  let sPrev = 0.0;
  let sPrev2 = 0.0;

  for (let i = 0; i < len; i++) {
    const s = samples[start + i] + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = s;
  }

  const power = sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
  return Math.max(0.0, power) / (len * len);
}

function decodeNibble(
  samples: Float32Array,
  start: number,
  params: ProfileParams
): { nibble: number; snrDb: number } {
  let bestK = 0;
  let bestP = -1.0;
  let sumP = 0.0;

  for (let k = 0; k < 16; k++) {
    const freq = params.baseFreqHz + k * params.toneSpacingHz;
    const p = goertzelPower(samples, start, params.symbolSamples, freq);
    sumP += p;
    if (p > bestP) {
      bestP = p;
      bestK = k;
    }
  }

  const noiseMean = Math.max(1e-18, (sumP - bestP) / 15.0);
  const snrDb = 10.0 * Math.log10(Math.max(1e-18, bestP) / noiseMean);
  return { nibble: bestK, snrDb };
}

export function findChirpOffset(
  samples: Float32Array,
  params: ProfileParams
): { offset: number; correlation: number } | null {
  const chirp = generateChirp(params);
  const cLen = chirp.length;
  if (samples.length < cLen) return null;

  let chirpEnergy = 0;
  for (let k = 0; k < cLen; k++) {
    chirpEnergy += chirp[k] * chirp[k];
  }
  if (chirpEnergy <= 1e-12) return null;

  const maxStart = samples.length - cLen;
  const coarseStep = 8;
  let bestCoarseIdx = 0;
  let bestCoarseCorr = 0;

  for (let i = 0; i <= maxStart; i += coarseStep) {
    let dot = 0;
    let sigEnergy = 0;
    for (let k = 0; k < cLen; k += 2) {
      const s = samples[i + k];
      const c = chirp[k];
      dot += s * c;
      sigEnergy += s * s;
    }
    if (sigEnergy > 1e-9) {
      const corr = dot / Math.sqrt(sigEnergy * (chirpEnergy * 0.5));
      if (corr > bestCoarseCorr) {
        bestCoarseCorr = corr;
        bestCoarseIdx = i;
      }
    }
  }

  if (bestCoarseCorr < 0.25) return null;

  const fineStart = Math.max(0, bestCoarseIdx - 16);
  const fineEnd = Math.min(maxStart, bestCoarseIdx + 16);
  let bestIdx = bestCoarseIdx;
  let bestCorr = 0;

  for (let pos = fineStart; pos <= fineEnd; pos++) {
    let dot = 0;
    let sigEnergy = 0;
    for (let k = 0; k < cLen; k++) {
      const s = samples[pos + k];
      const c = chirp[k];
      dot += s * c;
      sigEnergy += s * s;
    }
    if (sigEnergy > 1e-9) {
      const corr = dot / Math.sqrt(sigEnergy * chirpEnergy);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestIdx = pos;
      }
    }
  }

  return bestCorr >= 0.3 ? { offset: bestIdx, correlation: bestCorr } : null;
}

export function demodulateFrame(samples: Float32Array, profile: AcousticProfile): DemodResult {
  const params = getProfileParams(profile);
  const sync = findChirpOffset(samples, params);
  if (!sync) {
    throw new Error("Chirp preamble not detected");
  }

  const dataStart = sync.offset + params.chirpSamples + params.postChirpGapSamples;
  const symbolStride = params.symbolSamples + params.guardSamples;

  let snrAcc = 0;
  let snrCnt = 0;

  const readByte = (byteIdx: number): number => {
    const sym0Start = dataStart + byteIdx * 2 * symbolStride;
    const sym1Start = sym0Start + symbolStride;
    if (sym1Start + params.symbolSamples > samples.length) {
      throw new Error("Audio buffer truncated before frame end");
    }
    const d0 = decodeNibble(samples, sym0Start, params);
    const d1 = decodeNibble(samples, sym1Start, params);
    snrAcc += d0.snrDb + d1.snrDb;
    snrCnt += 2;
    return (d0.nibble << 4) | d1.nibble;
  };

  const header = new Uint8Array(HEADER_LEN);
  for (let i = 0; i < HEADER_LEN; i++) {
    header[i] = readByte(i);
  }

  if (header[0] !== FRAME_MAGIC[0] || header[1] !== FRAME_MAGIC[1]) {
    throw new Error("Invalid SD1 magic header");
  }
  if (header[2] !== FRAME_VERSION) {
    throw new Error(`Unsupported SD1 version: ${header[2]}`);
  }
  const payloadLen = (header[4] << 8) | header[5];
  if (payloadLen > MAX_PAYLOAD_LEN) {
    throw new Error(`Payload too large: ${payloadLen}`);
  }

  const totalLen = HEADER_LEN + payloadLen + TRAILER_LEN;
  const raw = new Uint8Array(totalLen);
  raw.set(header, 0);
  for (let i = HEADER_LEN; i < totalLen; i++) {
    raw[i] = readByte(i);
  }

  const frame = decodeFrame(raw);
  return {
    frame,
    snrDb: snrCnt > 0 ? snrAcc / snrCnt : 0,
    chirpOffset: sync.offset,
    correlation: sync.correlation,
  };
}

/**
 * Linear resampler to normalize browser AudioContext sample rates (e.g. 44100 Hz)
 * to the SD1 standard 48000 Hz.
 */
export function resampleTo48k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === SAMPLE_RATE) return input;
  const ratio = sourceRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

/**
 * Encode mono Float32Array @ 48000 Hz into IEEE float WAV bytes.
 */
export function encodeWav48k(samples: Float32Array): Uint8Array {
  const dataSize = samples.length * 4;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(44 + i * 4, Math.max(-1, Math.min(1, samples[i])), true);
  }
  return new Uint8Array(buffer);
}

/**
 * Decode PCM16 / PCM24 / PCM32 / Float32 WAV buffer into mono Float32Array.
 */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44) throw new Error("WAV file too short");

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = SAMPLE_RATE;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): actual format is in SubFormat GUID (first 2 bytes at fmt+24)
      if (audioFormat === 0xfffe && size >= 40) {
        audioFormat = view.getUint16(offset + 8 + 24, true);
      }
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error("WAV missing data chunk");
  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = Math.floor(dataSize / (bytesPerSample * numChannels));
  const out = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    const samplePos = dataOffset + i * bytesPerSample * numChannels;
    if (audioFormat === 3 && bitsPerSample === 32) {
      out[i] = view.getFloat32(samplePos, true);
    } else if (audioFormat === 1 && bitsPerSample === 16) {
      out[i] = view.getInt16(samplePos, true) / 32768.0;
    } else if (audioFormat === 1 && bitsPerSample === 32) {
      out[i] = view.getInt32(samplePos, true) / 2147483648.0;
    } else {
      throw new Error(`Unsupported WAV format: fmt=${audioFormat}, bits=${bitsPerSample}`);
    }
  }

  const normalized = sampleRate === SAMPLE_RATE ? out : resampleTo48k(out, sampleRate);
  return { samples: normalized, sampleRate: SAMPLE_RATE };
}
