use std::f64::consts::PI;
use thiserror::Error;

use crate::protocol::{
    AcousticProfile, Frame, ProfileParams, ProtocolError, HEADER_LEN, MAX_PAYLOAD_LEN,
    SAMPLE_RATE, TRAILER_LEN,
};

#[derive(Debug, Error)]
pub enum ModemError {
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("chirp preamble not detected")]
    PreambleNotFound,
    #[error("audio buffer truncated before frame end")]
    TruncatedAudio,
}

#[derive(Debug, Clone)]
pub struct DemodResult {
    pub frame: Frame,
    pub snr_db: f64,
    pub chirp_offset: usize,
    pub correlation: f64,
}

fn tukey_envelope(i: usize, len: usize, taper_frac: f64) -> f64 {
    let taper = ((len as f64) * taper_frac).round() as usize;
    if taper == 0 {
        return 1.0;
    }
    if i < taper {
        0.5 * (1.0 - (PI * (i as f64) / (taper as f64)).cos())
    } else if i >= len - taper {
        let j = len - 1 - i;
        0.5 * (1.0 - (PI * (j as f64) / (taper as f64)).cos())
    } else {
        1.0
    }
}

pub fn generate_chirp(params: &ProfileParams) -> Vec<f32> {
    let n = params.chirp_samples;
    let fs = SAMPLE_RATE as f64;
    let duration = (n as f64) / fs;
    let f0 = params.chirp_start_hz;
    let f1 = params.chirp_end_hz;
    let rate = (f1 - f0) / duration;

    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = (i as f64) / fs;
        let phase = 2.0 * PI * (f0 * t + 0.5 * rate * t * t);
        let env = tukey_envelope(i, n, 0.10);
        out.push((0.75 * env * phase.sin()) as f32);
    }
    out
}

pub fn modulate_frame(frame: &Frame, profile: AcousticProfile) -> Result<Vec<f32>, ModemError> {
    let bytes = frame.encode()?;
    let params = profile.params();
    let fs = SAMPLE_RATE as f64;

    let total_symbols = bytes.len() * 2;
    let symbol_stride = params.symbol_samples + params.guard_samples;
    let total_samples = params.lead_silence_samples
        + params.chirp_samples
        + params.post_chirp_gap_samples
        + total_symbols * symbol_stride
        + params.trail_silence_samples;

    let mut out = Vec::with_capacity(total_samples);
    out.resize(params.lead_silence_samples, 0.0);
    out.extend_from_slice(&generate_chirp(&params));
    out.resize(out.len() + params.post_chirp_gap_samples, 0.0);

    for &b in &bytes {
        let nibbles = [(b >> 4) & 0x0F, b & 0x0F];
        for nib in nibbles {
            let freq = params.base_freq_hz + (nib as f64) * params.tone_spacing_hz;
            for i in 0..params.symbol_samples {
                let t = (i as f64) / fs;
                let env = tukey_envelope(i, params.symbol_samples, 0.10);
                let sample = (0.75 * env * (2.0 * PI * freq * t).sin()) as f32;
                out.push(sample);
            }
            out.resize(out.len() + params.guard_samples, 0.0);
        }
    }

    out.resize(out.len() + params.trail_silence_samples, 0.0);
    Ok(out)
}

fn goertzel_power(samples: &[f32], freq_hz: f64) -> f64 {
    let n = samples.len();
    if n == 0 {
        return 0.0;
    }
    let omega = 2.0 * PI * freq_hz / (SAMPLE_RATE as f64);
    let coeff = 2.0 * omega.cos();
    let mut s_prev = 0.0_f64;
    let mut s_prev2 = 0.0_f64;

    for &x in samples {
        let s = (x as f64) + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }

    let power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
    power.max(0.0) / ((n * n) as f64)
}

fn decode_nibble(samples: &[f32], params: &ProfileParams) -> (u8, f64) {
    let mut powers = [0.0_f64; 16];
    let mut best_k = 0usize;
    let mut best_p = -1.0_f64;
    let mut sum_p = 0.0_f64;

    for (k, slot) in powers.iter_mut().enumerate() {
        let freq = params.base_freq_hz + (k as f64) * params.tone_spacing_hz;
        let p = goertzel_power(samples, freq);
        *slot = p;
        sum_p += p;
        if p > best_p {
            best_p = p;
            best_k = k;
        }
    }

    let noise_mean = ((sum_p - best_p) / 15.0).max(1e-18);
    let snr_db = 10.0 * (best_p.max(1e-18) / noise_mean).log10();
    (best_k as u8, snr_db)
}

fn find_chirp_offset(samples: &[f32], params: &ProfileParams) -> Option<(usize, f64)> {
    let chirp = generate_chirp(params);
    let c_len = chirp.len();
    if samples.len() < c_len {
        return None;
    }

    let chirp_energy: f64 = chirp.iter().map(|&v| (v as f64) * (v as f64)).sum();
    if chirp_energy <= 1e-12 {
        return None;
    }

    let max_start = samples.len() - c_len;
    let coarse_step = 8usize;
    let mut best_coarse_idx = 0usize;
    let mut best_coarse_corr = 0.0_f64;

    let mut i = 0usize;
    while i <= max_start {
        let mut dot = 0.0_f64;
        let mut sig_energy = 0.0_f64;
        // Sub-sample every 2nd sample during coarse search for 2x speedup
        let mut k = 0usize;
        while k < c_len {
            let s = samples[i + k] as f64;
            let c = chirp[k] as f64;
            dot += s * c;
            sig_energy += s * s;
            k += 2;
        }
        if sig_energy > 1e-9 {
            let corr = dot / (sig_energy * (chirp_energy * 0.5)).sqrt();
            if corr > best_coarse_corr {
                best_coarse_corr = corr;
                best_coarse_idx = i;
            }
        }
        i += coarse_step;
    }

    if best_coarse_corr < 0.25 {
        return None;
    }

    let fine_start = best_coarse_idx.saturating_sub(16);
    let fine_end = (best_coarse_idx + 16).min(max_start);
    let mut best_idx = best_coarse_idx;
    let mut best_corr = 0.0_f64;

    for pos in fine_start..=fine_end {
        let mut dot = 0.0_f64;
        let mut sig_energy = 0.0_f64;
        for k in 0..c_len {
            let s = samples[pos + k] as f64;
            let c = chirp[k] as f64;
            dot += s * c;
            sig_energy += s * s;
        }
        if sig_energy > 1e-9 {
            let corr = dot / (sig_energy * chirp_energy).sqrt();
            if corr > best_corr {
                best_corr = corr;
                best_idx = pos;
            }
        }
    }

    if best_corr >= 0.30 {
        Some((best_idx, best_corr))
    } else {
        None
    }
}

pub fn demodulate_frame(samples: &[f32], profile: AcousticProfile) -> Result<DemodResult, ModemError> {
    let params = profile.params();
    let (chirp_offset, correlation) =
        find_chirp_offset(samples, &params).ok_or(ModemError::PreambleNotFound)?;

    let data_start = chirp_offset + params.chirp_samples + params.post_chirp_gap_samples;
    let symbol_stride = params.symbol_samples + params.guard_samples;

    // Helper to read a single byte at byte_index
    let read_byte = |byte_idx: usize, snr_acc: &mut f64, snr_cnt: &mut usize| -> Result<u8, ModemError> {
        let sym0_start = data_start + (byte_idx * 2) * symbol_stride;
        let sym1_start = sym0_start + symbol_stride;
        if sym1_start + params.symbol_samples > samples.len() {
            return Err(ModemError::TruncatedAudio);
        }
        let (hi, snr0) = decode_nibble(&samples[sym0_start..sym0_start + params.symbol_samples], &params);
        let (lo, snr1) = decode_nibble(&samples[sym1_start..sym1_start + params.symbol_samples], &params);
        *snr_acc += snr0 + snr1;
        *snr_cnt += 2;
        Ok((hi << 4) | lo)
    };

    let mut snr_acc = 0.0_f64;
    let mut snr_cnt = 0usize;

    let mut raw = Vec::with_capacity(HEADER_LEN + TRAILER_LEN);
    for idx in 0..HEADER_LEN {
        raw.push(read_byte(idx, &mut snr_acc, &mut snr_cnt)?);
    }

    if raw[0..2] != crate::protocol::FRAME_MAGIC {
        return Err(ModemError::Protocol(ProtocolError::InvalidMagic));
    }
    if raw[2] != crate::protocol::FRAME_VERSION {
        return Err(ModemError::Protocol(ProtocolError::UnsupportedVersion(raw[2])));
    }
    let payload_len = u16::from_be_bytes([raw[4], raw[5]]) as usize;
    if payload_len > MAX_PAYLOAD_LEN {
        return Err(ModemError::Protocol(ProtocolError::PayloadTooLarge(payload_len)));
    }

    let remaining = payload_len + TRAILER_LEN;
    raw.reserve(remaining);
    for idx in HEADER_LEN..HEADER_LEN + remaining {
        raw.push(read_byte(idx, &mut snr_acc, &mut snr_cnt)?);
    }

    let frame = Frame::decode(&raw)?;
    let avg_snr_db = if snr_cnt > 0 {
        snr_acc / (snr_cnt as f64)
    } else {
        0.0
    };

    Ok(DemodResult {
        frame,
        snr_db: avg_snr_db,
        chirp_offset,
        correlation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::FLAG_ENCRYPTED;

    fn pseudo_noise(len: usize, amplitude: f32, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let norm = (((state >> 32) as u32) as f32 / (u32::MAX as f32)) * 2.0 - 1.0;
                norm * amplitude
            })
            .collect()
    }

    #[test]
    fn roundtrip_all_profiles() {
        let payload = b"SD1-WebRTC-Room:7F9A2C".to_vec();
        let frame = Frame::new(FLAG_ENCRYPTED, payload).unwrap();

        for profile in [
            AcousticProfile::Audible,
            AcousticProfile::Fast,
            AcousticProfile::Ultrasonic,
        ] {
            let audio = modulate_frame(&frame, profile).unwrap();
            let decoded = demodulate_frame(&audio, profile).unwrap();
            assert_eq!(decoded.frame, frame);
            assert!(decoded.snr_db > 15.0, "SNR too low for {:?}", profile);
        }
    }

    #[test]
    fn roundtrip_with_noise_and_offset() {
        let frame = Frame::new(0, b"AirGap-Handshake-OK!".to_vec()).unwrap();
        let audio = modulate_frame(&frame, AcousticProfile::Audible).unwrap();
        let mut noisy = vec![0.0_f32; 3123];
        noisy.extend_from_slice(&audio);
        let noise = pseudo_noise(noisy.len(), 0.08, 42);
        for (s, n) in noisy.iter_mut().zip(noise.iter()) {
            *s += *n;
        }
        let decoded = demodulate_frame(&noisy, AcousticProfile::Audible).unwrap();
        assert_eq!(decoded.frame, frame);
    }
}
