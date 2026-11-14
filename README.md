# SoundDrop Alpha

Plateforme unifiée et interopérable de transfert P2P hors-ligne et LAN combinant :
1. **Un modem acoustique 16-FSK + Chirp Sync (`SD1`)** écrit en **Rust** (`crates/sounddrop_core`, `crates/sounddrop_cli`) et porté à l'identique en **TypeScript** (`apps/web/src/lib/acoustic`), vérifié par des **vecteurs de test croisés (`test-vectors/`)**.
2. **Un canal P2P WebRTC chiffré de bout en bout** (`ECDH P-256 + HKDF-SHA-256 + AES-256-GCM`) activé par défaut, avec **code de vérification visuelle SAS à 6 chiffres**.
3. **Accès réel au système de fichiers local** (`window.showDirectoryPicker()` + fallback `<input type="file" webkitdirectory>`), **état initial vide obligatoire** et **zéro donnée fictive**.

---

## Structure du Dépôt

- `PROTOCOL.md` — Spécification unique du protocole binaire `SD1` (`48000 Hz`, 16-FSK, Chirp, CRC-32 IEEE 802.3).
- `crates/sounddrop_core` — Moteur Rust (modulation/démodulation 16-FSK, chiffrement ChaCha20-Poly1305/X25519, I/O WAV).
- `crates/sounddrop_cli` — Outil CLI natif (`encode-wav`, `decode-wav`, `export-vectors`).
- `test-vectors/` — Vecteurs dorés générés par Rust et validés automatiquement dans la suite Vitest du client Web.
- `apps/web` — Application Next.js 14 (TypeScript + Tailwind + `AudioWorklet` sans larsen + WebRTC + QR/SDP hors-ligne).

---

## Vérification & Tests

### 1. Moteur Rust & Vecteurs Croisés
```bash
cargo test --workspace
cargo run -p sounddrop_cli -- export-vectors --dir test-vectors
```

### 2. Application Web & Compatibilité Rust ↔ Web
```bash
cd apps/web
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

### 3. Tester l'interopérabilité directe CLI Rust ↔ Web
```bash
# Générer un fichier WAV depuis le CLI Rust
cargo run -p sounddrop_cli -- encode-wav --message "SD1-ROOM:TEST99" --out test.wav --profile audible
# Importer test.wav dans l'onglet "Décoder .WAV" de l'application Web (ou inversement)
```
