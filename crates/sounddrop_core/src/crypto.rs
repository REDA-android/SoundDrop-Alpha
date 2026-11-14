use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use thiserror::Error;
use x25519_dalek::{EphemeralSecret, PublicKey};

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("encryption failed")]
    EncryptFailed,
    #[error("decryption failed (wrong key or tampered ciphertext)")]
    DecryptFailed,
    #[error("ciphertext too short")]
    CiphertextTooShort,
    #[error("entropy generation failed")]
    EntropyFailed,
}

pub struct Keypair {
    secret: EphemeralSecret,
    pub public: PublicKey,
}

impl Keypair {
    pub fn generate() -> Self {
        let secret = EphemeralSecret::random_from_rng(OsRngAdapter);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn derive_session(self, peer_public: &PublicKey) -> SessionCipher {
        let shared = self.secret.diffie_hellman(peer_public);
        let key_material = blake3::derive_key("sounddrop-sd1-session-v1", shared.as_bytes());
        let sas_hash = blake3::derive_key("sounddrop-sd1-sas-v1", shared.as_bytes());
        let sas_num = u32::from_be_bytes([sas_hash[0], sas_hash[1], sas_hash[2], sas_hash[3]]) % 1_000_000;
        SessionCipher {
            key: key_material,
            sas_code: format!("{:06}", sas_num),
        }
    }
}

pub struct SessionCipher {
    key: [u8; 32],
    pub sas_code: String,
}

impl SessionCipher {
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| CryptoError::EncryptFailed)?;
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).map_err(|_| CryptoError::EntropyFailed)?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| CryptoError::EncryptFailed)?;
        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if data.len() < 12 + 16 {
            return Err(CryptoError::CiphertextTooShort);
        }
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| CryptoError::DecryptFailed)?;
        let nonce = Nonce::from_slice(&data[..12]);
        cipher
            .decrypt(nonce, &data[12..])
            .map_err(|_| CryptoError::DecryptFailed)
    }
}

struct OsRngAdapter;

impl rand_core_compat::CryptoRng for OsRngAdapter {}

mod rand_core_compat {
    pub use chacha20poly1305::aead::rand_core::{CryptoRng, Error, RngCore};
}

impl rand_core_compat::RngCore for OsRngAdapter {
    fn next_u32(&mut self) -> u32 {
        let mut out = [0u8; 4];
        self.fill_bytes(&mut out);
        u32::from_le_bytes(out)
    }

    fn next_u64(&mut self) -> u64 {
        let mut out = [0u8; 8];
        self.fill_bytes(&mut out);
        u64::from_le_bytes(out)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        let _ = getrandom::getrandom(dest);
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core_compat::Error> {
        getrandom::getrandom(dest).map_err(|e| rand_core_compat::Error::from(e.code()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e2e_session_and_sas_match() {
        let alice = Keypair::generate();
        let bob = Keypair::generate();
        let alice_pub = alice.public;
        let bob_pub = bob.public;

        let alice_sess = alice.derive_session(&bob_pub);
        let bob_sess = bob.derive_session(&alice_pub);

        assert_eq!(alice_sess.sas_code, bob_sess.sas_code);
        assert_eq!(alice_sess.sas_code.len(), 6);

        let ct = alice_sess.encrypt(b"secret payload").unwrap();
        let pt = bob_sess.decrypt(&ct).unwrap();
        assert_eq!(pt, b"secret payload");
    }
}
