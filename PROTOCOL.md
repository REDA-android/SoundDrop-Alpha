# SoundDrop Wire Protocol v1 (`SD1`)

This specification is the **single source of truth** shared by the Rust native engine (`crates/sounddrop_core`) and the Web/TypeScript engine (`apps/web/src/lib/acoustic`). Both implementations produce and decode identical audio waveforms and frames, verified by shared golden test vectors (`test-vectors/`).

---

## 1. Physical Layer (16-FSK + Chirp Sync)

- **Sample Rate ($f_s$)**: `48000 Hz` (mono `f32`, range `[-1.0, 1.0]`).
  - If a browser `AudioContext` runs at another rate (e.g. `44100 Hz`), the receiver resamples to `48000 Hz` before demodulation.
- **Modulation**: 16-FSK (4 bits / 1 nibble per symbol).
  - Each byte is transmitted **high nibble first** `(byte >> 4) & 0x0F`, then **low nibble** `byte & 0x0F`.
- **Pulse Shaping**: Raised-cosine (Tukey) edge taper (`10%` of symbol duration on each side) to eliminate spectral splatter and speaker clicks.

### Acoustic Profiles

| Profile ID | Name | Base Freq ($f_0$) | Spacing ($\Delta f$) | Tone Range ($k=0..15$) | Symbol Samples | Guard Samples | Chirp Range |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `0` | `audible` | `1600 Hz` | `150 Hz` | `1600 – 3850 Hz` | `1920` (40 ms) | `240` (5 ms) | `1200 → 4200 Hz` |
| `1` | `fast` | `1600 Hz` | `200 Hz` | `1600 – 4600 Hz` | `960` (20 ms) | `96` (2 ms) | `1200 → 4200 Hz` |
| `2` | `ultrasonic` | `17600 Hz` | `120 Hz` | `17600 – 19400 Hz` | `1920` (40 ms) | `240` (5 ms) | `17200 → 19800 Hz` |

### Synchronization Preamble
1. **Lead Silence**: `2400` samples (`50 ms`) of zeros.
2. **Linear Up-Chirp**: `4800` samples (`100 ms`) sweeping linearly from `chirp_start` to `chirp_end` with `10%` Tukey fade-in/fade-out, amplitude `0.75`.
3. **Post-Chirp Gap**: `480` samples (`10 ms`) of zeros.
4. **Data Symbols**: `2 * frame_bytes.len()` symbols, each `(symbol_samples + guard_samples)` long.
5. **Trail Silence**: `2400` samples (`50 ms`) of zeros.

---

## 2. Data Link Layer (`SD1` Frame Format)

All multi-byte integers are **Big-Endian**.

| Offset | Size | Field | Description |
| :--- | :--- | :--- | :--- |
| `0` | `2` | `magic` | ASCII `"SD"` (`0x53, 0x44`) |
| `2` | `1` | `version` | `0x01` |
| `3` | `1` | `flags` | Bit `0`: Encrypted (`0x01`), Bit `1`: Compressed (`0x02`) |
| `4` | `2` | `length` | Payload length $L \in [0, 512]$ (`u16` BE) |
| `6` | $L$ | `payload` | Raw or encrypted/compressed payload bytes |
| `6 + L` | `4` | `crc32` | Standard IEEE 802.3 CRC-32 (`0xEDB88320`) over bytes `[0 .. 6 + L]` |

Total frame size: `10 + L` bytes (`20 + 2*L` 16-FSK symbols).

---

## 3. End-to-End Encryption & SAS Verification

- **WebRTC / Session Key Exchange**: ECDH (P-256 on WebCrypto) / X25519 (Rust) + HKDF-SHA-256 deriving a 256-bit session key + 6-digit **Short Authentication String (SAS)** (`000000`–`999999`) for visual out-of-band co-presence verification.
- **Cipher**: Authenticated encryption (`AES-256-GCM` in WebRTC session / `ChaCha20-Poly1305` in Rust core) enabled **by default**.
