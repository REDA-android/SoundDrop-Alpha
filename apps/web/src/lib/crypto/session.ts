export interface EphemeralKeyPair {
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  publicKeyB64: string;
}

export interface EncryptedSession {
  sasCode: string;
  encrypt: (plaintext: Uint8Array) => Promise<Uint8Array>;
  decrypt: (data: Uint8Array) => Promise<Uint8Array>;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeyRaw: raw,
    publicKeyB64: toBase64Url(raw),
  };
}

export async function deriveEncryptedSession(
  ownPrivateKey: CryptoKey,
  peerPublicKeyB64: string
): Promise<EncryptedSession> {
  const peerRaw = fromBase64Url(peerPublicKeyB64);
  const peerKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(peerRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    ownPrivateKey,
    256
  );

  const hkdfBase = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);

  const salt = new TextEncoder().encode("sounddrop-alpha-v1");

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("aes-256-gcm-session"),
    },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const sasBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: new TextEncoder().encode("sas-6-digit"),
      },
      hkdfBase,
      32
    )
  );
  const view = new DataView(sasBits.buffer);
  const sasNum = view.getUint32(0, false) % 1_000_000;
  const sasCode = sasNum.toString().padStart(6, "0");

  return {
    sasCode,
    encrypt: async (plaintext: Uint8Array) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new Uint8Array(plaintext))
      );
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0);
      out.set(ct, 12);
      return out;
    },
    decrypt: async (data: Uint8Array) => {
      if (data.length < 12 + 16) {
        throw new Error("Encrypted payload too short");
      }
      const iv = data.subarray(0, 12);
      const ct = data.subarray(12);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        aesKey,
        new Uint8Array(ct)
      );
      return new Uint8Array(pt);
    },
  };
}
