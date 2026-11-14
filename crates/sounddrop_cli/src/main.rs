use std::path::PathBuf;
use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use sounddrop_core::modem::{demodulate_frame, modulate_frame};
use sounddrop_core::protocol::{AcousticProfile, Frame};
use sounddrop_core::wav::{read_wav, write_wav};

#[derive(Parser)]
#[command(name = "sounddrop", about = "SoundDrop Alpha — Unified SD1 Acoustic Modem CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, ValueEnum)]
enum ProfileArg {
    Audible,
    Fast,
    Ultrasonic,
}

impl From<ProfileArg> for AcousticProfile {
    fn from(value: ProfileArg) -> Self {
        match value {
            ProfileArg::Audible => AcousticProfile::Audible,
            ProfileArg::Fast => AcousticProfile::Fast,
            ProfileArg::Ultrasonic => AcousticProfile::Ultrasonic,
        }
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Encode a UTF-8 message into a 48 kHz SD1 WAV file
    EncodeWav {
        #[arg(short, long)]
        message: String,
        #[arg(short, long)]
        out: PathBuf,
        #[arg(short, long, value_enum, default_value = "audible")]
        profile: ProfileArg,
    },
    /// Decode a 48 kHz SD1 WAV file
    DecodeWav {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long, value_enum, default_value = "audible")]
        profile: ProfileArg,
    },
    /// Export golden test vectors (JSON + WAV) for cross-platform Web <-> Rust verification
    ExportVectors {
        #[arg(short, long, default_value = "test-vectors")]
        dir: PathBuf,
    },
}

#[derive(Serialize)]
struct GoldenVector {
    profile: AcousticProfile,
    payload_utf8: String,
    frame_bytes: Vec<u8>,
    wav_file: String,
    sample_count: usize,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::EncodeWav { message, out, profile } => {
            let prof: AcousticProfile = profile.into();
            let frame = Frame::new(0, message.into_bytes())?;
            let samples = modulate_frame(&frame, prof)?;
            write_wav(&out, &samples)?;
            println!("Wrote {} samples ({:.2}s) to {}", samples.len(), samples.len() as f64 / 48000.0, out.display());
        }
        Commands::DecodeWav { input, profile } => {
            let prof: AcousticProfile = profile.into();
            let samples = read_wav(&input)?;
            let res = demodulate_frame(&samples, prof)?;
            let text = String::from_utf8_lossy(&res.frame.payload);
            println!("Decoded ({} bytes, SNR {:.1} dB, corr {:.3}): {}", res.frame.payload.len(), res.snr_db, res.correlation, text);
        }
        Commands::ExportVectors { dir } => {
            std::fs::create_dir_all(&dir)?;
            let cases = [
                (AcousticProfile::Audible, "SD1-AIRGAP-HANDSHAKE", "sd1_audible.wav"),
                (AcousticProfile::Fast, "SD1-FAST-TEST-2026", "sd1_fast.wav"),
                (AcousticProfile::Ultrasonic, "SD1-ULTRASONIC-OK", "sd1_ultrasonic.wav"),
            ];
            let mut manifest = Vec::new();
            for (prof, msg, wav_name) in cases {
                let frame = Frame::new(0, msg.as_bytes().to_vec())?;
                let frame_bytes = frame.encode()?;
                let samples = modulate_frame(&frame, prof)?;
                write_wav(&dir.join(wav_name), &samples)?;
                manifest.push(GoldenVector {
                    profile: prof,
                    payload_utf8: msg.to_string(),
                    frame_bytes,
                    wav_file: wav_name.to_string(),
                    sample_count: samples.len(),
                });
            }
            let json = serde_json::to_string_pretty(&manifest)?;
            std::fs::write(dir.join("vectors.json"), json)?;
            println!("Exported {} golden test vectors to {}", manifest.len(), dir.display());
        }
    }
    Ok(())
}
