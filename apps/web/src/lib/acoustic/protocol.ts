export const SAMPLE_RATE = 48_000;
export const FRAME_MAGIC = [0x53, 0x44] as const; // "SD"
export const FRAME_VERSION = 0x01;
export const MAX_PAYLOAD_LEN = 512;
export const HEADER_LEN = 6;
export const TRAILER_LEN = 4;

export const FLAG_ENCRYPTED = 0x01;
export const FLAG_COMPRESSED = 0x02;

export type AcousticProfile = "audible" | "fast" | "ultrasonic";

export interface ProfileParams {
  profile: AcousticProfile;
  baseFreqHz: number;
  toneSpacingHz: number;
  symbolSamples: number;
  guardSamples: number;
  chirpStartHz: number;
  chirpEndHz: number;
  chirpSamples: number;
  leadSilenceSamples: number;
  postChirpGapSamples: number;
  trailSilenceSamples: number;
}

export function getProfileParams(profile: AcousticProfile): ProfileParams {
  switch (profile) {
    case "audible":
      return {
        profile,
        baseFreqHz: 1600,
        toneSpacingHz: 150,
        symbolSamples: 1920,
        guardSamples: 240,
        chirpStartHz: 1200,
        chirpEndHz: 4200,
        chirpSamples: 4800,
        leadSilenceSamples: 2400,
        postChirpGapSamples: 480,
        trailSilenceSamples: 2400,
      };
    case "fast":
      return {
        profile,
        baseFreqHz: 1600,
        toneSpacingHz: 200,
        symbolSamples: 960,
        guardSamples: 96,
        chirpStartHz: 1200,
        chirpEndHz: 4200,
        chirpSamples: 4800,
        leadSilenceSamples: 2400,
        postChirpGapSamples: 480,
        trailSilenceSamples: 2400,
      };
    case "ultrasonic":
      return {
        profile,
        baseFreqHz: 17600,
        toneSpacingHz: 120,
        symbolSamples: 1920,
        guardSamples: 240,
        chirpStartHz: 17200,
        chirpEndHz: 19800,
        chirpSamples: 4800,
        leadSilenceSamples: 2400,
        postChirpGapSamples: 480,
        trailSilenceSamples: 2400,
      };
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface SD1Frame {
  flags: number;
  payload: Uint8Array;
}

export function encodeFrame(frame: SD1Frame): Uint8Array {
  if (frame.payload.length > MAX_PAYLOAD_LEN) {
    throw new Error(`Payload too large: ${frame.payload.length} bytes (max ${MAX_PAYLOAD_LEN})`);
  }
  const len = frame.payload.length;
  const out = new Uint8Array(HEADER_LEN + len + TRAILER_LEN);
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = FRAME_VERSION;
  out[3] = frame.flags & 0xff;
  out[4] = (len >>> 8) & 0xff;
  out[5] = len & 0xff;
  out.set(frame.payload, HEADER_LEN);

  const checksum = crc32(out.subarray(0, HEADER_LEN + len));
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(HEADER_LEN + len, checksum, false);
  return out;
}

export function decodeFrame(raw: Uint8Array): SD1Frame {
  if (raw.length < HEADER_LEN + TRAILER_LEN) {
    throw new Error(`Frame too short: ${raw.length} bytes`);
  }
  if (raw[0] !== FRAME_MAGIC[0] || raw[1] !== FRAME_MAGIC[1]) {
    throw new Error("Invalid SD1 magic header");
  }
  if (raw[2] !== FRAME_VERSION) {
    throw new Error(`Unsupported SD1 version: ${raw[2]}`);
  }
  const flags = raw[3];
  const payloadLen = (raw[4] << 8) | raw[5];
  if (payloadLen > MAX_PAYLOAD_LEN) {
    throw new Error(`Payload too large: ${payloadLen}`);
  }
  const expectedTotal = HEADER_LEN + payloadLen + TRAILER_LEN;
  if (raw.length < expectedTotal) {
    throw new Error(`Length mismatch: expected ${expectedTotal}, got ${raw.length}`);
  }
  const body = raw.subarray(0, HEADER_LEN + payloadLen);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const expectedCrc = view.getUint32(HEADER_LEN + payloadLen, false);
  const actualCrc = crc32(body);
  if (actualCrc !== expectedCrc) {
    throw new Error(
      `CRC-32 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`
    );
  }
  return {
    flags,
    payload: raw.slice(HEADER_LEN, HEADER_LEN + payloadLen),
  };
}
