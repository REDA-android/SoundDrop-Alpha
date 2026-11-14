use std::path::Path;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use thiserror::Error;

use crate::protocol::SAMPLE_RATE;

#[derive(Debug, Error)]
pub enum WavError {
    #[error("WAV I/O error: {0}")]
    Hound(#[from] hound::Error),
    #[error("unsupported sample rate {0} Hz (expected {SAMPLE_RATE} Hz)")]
    UnsupportedSampleRate(u32),
}

pub fn write_wav(path: &Path, samples: &[f32]) -> Result<(), WavError> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec)?;
    for &s in samples {
        writer.write_sample(s.clamp(-1.0, 1.0))?;
    }
    writer.finalize()?;
    Ok(())
}

pub fn read_wav(path: &Path) -> Result<Vec<f32>, WavError> {
    let mut reader = WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(WavError::UnsupportedSampleRate(spec.sample_rate));
    }
    let channels = spec.channels as usize;
    let raw: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        SampleFormat::Int => {
            let max_val = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|r| r.map(|v| (v as f32) / max_val))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    if channels == 1 {
        Ok(raw)
    } else {
        Ok(raw.chunks(channels).map(|c| c[0]).collect())
    }
}
