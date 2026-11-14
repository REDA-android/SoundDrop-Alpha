import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeFrame, encodeFrame, AcousticProfile } from "./protocol";
import { decodeWav, demodulateFrame, encodeWav48k, modulateFrame, resampleTo48k } from "./modem";
import { deriveEncryptedSession, generateEphemeralKeyPair } from "../crypto/session";

interface GoldenVector {
  profile: AcousticProfile;
  payload_utf8: string;
  frame_bytes: number[];
  wav_file: string;
  sample_count: number;
}

describe("SD1 Protocol & Modem", () => {
  it("encodes and decodes frames with CRC-32 verification", () => {
    const payload = new TextEncoder().encode("SoundDrop-Alpha-SD1");
    const encoded = encodeFrame({ flags: 0x01, payload });
    const decoded = decodeFrame(encoded);
    expect(decoded.flags).toBe(0x01);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));

    // Flip a bit in payload and verify CRC rejection
    const corrupted = new Uint8Array(encoded);
    corrupted[6] ^= 0xff;
    expect(() => decodeFrame(corrupted)).toThrow(/CRC-32 mismatch/);
  });

  it("round-trips all acoustic profiles in pure TypeScript", () => {
    const payload = new TextEncoder().encode("SD1-ROOM:9A4F1B");
    for (const profile of ["audible", "fast", "ultrasonic"] as AcousticProfile[]) {
      const samples = modulateFrame({ flags: 0, payload }, profile);
      const res = demodulateFrame(samples, profile);
      expect(new TextDecoder().decode(res.frame.payload)).toBe("SD1-ROOM:9A4F1B");
      expect(res.snrDb).toBeGreaterThan(15);
    }
  });

  it("handles 44100 Hz browser resampling to 48000 Hz", () => {
    const payload = new TextEncoder().encode("Resample-OK");
    const samples48k = modulateFrame({ flags: 0, payload }, "audible");
    // Simulate 44100 Hz capture by resampling 48k -> 44.1k, then back to 48k
    const ratio = 48000 / 44100;
    const len44k = Math.floor(samples48k.length / ratio);
    const samples44k = new Float32Array(len44k);
    for (let i = 0; i < len44k; i++) {
      const idx = Math.floor(i * ratio);
      samples44k[i] = samples48k[Math.min(idx, samples48k.length - 1)];
    }
    const restored48k = resampleTo48k(samples44k, 44100);
    const res = demodulateFrame(restored48k, "audible");
    expect(new TextDecoder().decode(res.frame.payload)).toBe("Resample-OK");
  });

  it("round-trips WAV encode/decode", () => {
    const payload = new TextEncoder().encode("WAV-Test-48k");
    const samples = modulateFrame({ flags: 0, payload }, "fast");
    const wavBytes = encodeWav48k(samples);
    const { samples: decodedSamples } = decodeWav(wavBytes);
    const res = demodulateFrame(decodedSamples, "fast");
    expect(new TextDecoder().decode(res.frame.payload)).toBe("WAV-Test-48k");
  });

  it("decodes Rust-generated golden WAV vectors byte-for-byte", () => {
    const vectorsDir = path.resolve(__dirname, "../../../../../test-vectors");
    const manifestPath = path.join(vectorsDir, "vectors.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as GoldenVector[];

    expect(manifest.length).toBe(3);

    for (const vec of manifest) {
      // 1. Frame bytes must match Rust byte-for-byte
      const tsFrameBytes = encodeFrame({
        flags: 0,
        payload: new TextEncoder().encode(vec.payload_utf8),
      });
      expect(Array.from(tsFrameBytes)).toEqual(vec.frame_bytes);

      // 2. Rust-generated WAV must demodulate cleanly in TypeScript
      const wavBytes = new Uint8Array(fs.readFileSync(path.join(vectorsDir, vec.wav_file)));
      const { samples } = decodeWav(wavBytes);
      expect(samples.length).toBe(vec.sample_count);

      const decoded = demodulateFrame(samples, vec.profile);
      expect(new TextDecoder().decode(decoded.frame.payload)).toBe(vec.payload_utf8);
      expect(decoded.snrDb).toBeGreaterThan(15);
    }
  });

  it("derives matching ECDH P-256 AES-256-GCM session and 6-digit SAS", async () => {
    const alice = await generateEphemeralKeyPair();
    const bob = await generateEphemeralKeyPair();

    const aliceSession = await deriveEncryptedSession(alice.privateKey, bob.publicKeyB64);
    const bobSession = await deriveEncryptedSession(bob.privateKey, alice.publicKeyB64);

    expect(aliceSession.sasCode).toBe(bobSession.sasCode);
    expect(aliceSession.sasCode).toMatch(/^\d{6}$/);

    const plain = new TextEncoder().encode("Confidential AirGap Chunk");
    const ct = await aliceSession.encrypt(plain);
    const pt = await bobSession.decrypt(ct);
    expect(new TextDecoder().decode(pt)).toBe("Confidential AirGap Chunk");
  });
});
