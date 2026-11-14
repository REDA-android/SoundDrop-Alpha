use crc32fast::Hasher;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_MAGIC: [u8; 2] = [0x53, 0x44]; // "SD"
pub const FRAME_VERSION: u8 = 0x01;
pub const MAX_PAYLOAD_LEN: usize = 512;
pub const HEADER_LEN: usize = 6;
pub const TRAILER_LEN: usize = 4;

pub const FLAG_ENCRYPTED: u8 = 0x01;
pub const FLAG_COMPRESSED: u8 = 0x02;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("payload too large: {0} bytes (max {MAX_PAYLOAD_LEN})")]
    PayloadTooLarge(usize),
    #[error("frame too short: {0} bytes")]
    FrameTooShort(usize),
    #[error("invalid magic header")]
    InvalidMagic,
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u8),
    #[error("length mismatch: expected {expected} bytes, got {actual}")]
    LengthMismatch { expected: usize, actual: usize },
    #[error("CRC-32 mismatch: expected {expected:#010x}, got {actual:#010x}")]
    CrcMismatch { expected: u32, actual: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcousticProfile {
    Audible,
    Fast,
    Ultrasonic,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProfileParams {
    pub profile: AcousticProfile,
    pub base_freq_hz: f64,
    pub tone_spacing_hz: f64,
    pub symbol_samples: usize,
    pub guard_samples: usize,
    pub chirp_start_hz: f64,
    pub chirp_end_hz: f64,
    pub chirp_samples: usize,
    pub lead_silence_samples: usize,
    pub post_chirp_gap_samples: usize,
    pub trail_silence_samples: usize,
}

impl AcousticProfile {
    pub fn params(self) -> ProfileParams {
        match self {
            AcousticProfile::Audible => ProfileParams {
                profile: self,
                base_freq_hz: 1600.0,
                tone_spacing_hz: 150.0,
                symbol_samples: 1920,
                guard_samples: 240,
                chirp_start_hz: 1200.0,
                chirp_end_hz: 4200.0,
                chirp_samples: 4800,
                lead_silence_samples: 2400,
                post_chirp_gap_samples: 480,
                trail_silence_samples: 2400,
            },
            AcousticProfile::Fast => ProfileParams {
                profile: self,
                base_freq_hz: 1600.0,
                tone_spacing_hz: 200.0,
                symbol_samples: 960,
                guard_samples: 96,
                chirp_start_hz: 1200.0,
                chirp_end_hz: 4200.0,
                chirp_samples: 4800,
                lead_silence_samples: 2400,
                post_chirp_gap_samples: 480,
                trail_silence_samples: 2400,
            },
            AcousticProfile::Ultrasonic => ProfileParams {
                profile: self,
                base_freq_hz: 17600.0,
                tone_spacing_hz: 120.0,
                symbol_samples: 1920,
                guard_samples: 240,
                chirp_start_hz: 17200.0,
                chirp_end_hz: 19800.0,
                chirp_samples: 4800,
                lead_silence_samples: 2400,
                post_chirp_gap_samples: 480,
                trail_silence_samples: 2400,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub flags: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(flags: u8, payload: Vec<u8>) -> Result<Self, ProtocolError> {
        if payload.len() > MAX_PAYLOAD_LEN {
            return Err(ProtocolError::PayloadTooLarge(payload.len()));
        }
        Ok(Self { flags, payload })
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.payload.len() > MAX_PAYLOAD_LEN {
            return Err(ProtocolError::PayloadTooLarge(self.payload.len()));
        }
        let len = self.payload.len() as u16;
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len() + TRAILER_LEN);
        out.extend_from_slice(&FRAME_MAGIC);
        out.push(FRAME_VERSION);
        out.push(self.flags);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&self.payload);

        let mut hasher = Hasher::new();
        hasher.update(&out);
        let crc = hasher.finalize();
        out.extend_from_slice(&crc.to_be_bytes());
        Ok(out)
    }

    pub fn decode(raw: &[u8]) -> Result<Self, ProtocolError> {
        if raw.len() < HEADER_LEN + TRAILER_LEN {
            return Err(ProtocolError::FrameTooShort(raw.len()));
        }
        if raw[0..2] != FRAME_MAGIC {
            return Err(ProtocolError::InvalidMagic);
        }
        if raw[2] != FRAME_VERSION {
            return Err(ProtocolError::UnsupportedVersion(raw[2]));
        }
        let flags = raw[3];
        let payload_len = u16::from_be_bytes([raw[4], raw[5]]) as usize;
        let expected_total = HEADER_LEN + payload_len + TRAILER_LEN;
        if raw.len() < expected_total {
            return Err(ProtocolError::LengthMismatch {
                expected: expected_total,
                actual: raw.len(),
            });
        }
        let body = &raw[..HEADER_LEN + payload_len];
        let expected_crc = u32::from_be_bytes([
            raw[HEADER_LEN + payload_len],
            raw[HEADER_LEN + payload_len + 1],
            raw[HEADER_LEN + payload_len + 2],
            raw[HEADER_LEN + payload_len + 3],
        ]);
        let mut hasher = Hasher::new();
        hasher.update(body);
        let actual_crc = hasher.finalize();
        if actual_crc != expected_crc {
            return Err(ProtocolError::CrcMismatch {
                expected: expected_crc,
                actual: actual_crc,
            });
        }
        Ok(Self {
            flags,
            payload: raw[HEADER_LEN..HEADER_LEN + payload_len].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let frame = Frame::new(FLAG_ENCRYPTED, b"SoundDrop-SD1".to_vec()).unwrap();
        let encoded = frame.encode().unwrap();
        let decoded = Frame::decode(&encoded).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn frame_crc_detects_corruption() {
        let frame = Frame::new(0, b"hello".to_vec()).unwrap();
        let mut encoded = frame.encode().unwrap();
        encoded[6] ^= 0xFF;
        assert!(matches!(
            Frame::decode(&encoded),
            Err(ProtocolError::CrcMismatch { .. })
        ));
    }
}
