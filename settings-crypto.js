// settings-crypto.js
// Passphrase-based encryption for the API keys in an exported settings file.
//
//   passphrase --PBKDF2-HMAC-SHA256 (600,000 iterations, random 16-byte salt)--> AES-256 key
//   plaintext  --AES-256-GCM (random 12-byte IV, authenticated)--------------> ciphertext
//
// Uses only the standard WebCrypto API (available in extension pages and
// Node 18+), so there is no dependency to audit. A wrong passphrase or any
// modification of the file makes decryption fail (GCM authentication), never
// return garbage.

export const SECRETS_ENVELOPE_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 10;

const KDF_NAME = "PBKDF2-SHA256";
const KDF_ITERATIONS = 600000;
// Bounds accepted when READING a file, so a crafted file cannot pin the CPU.
const KDF_MIN_ITERATIONS = 100000;
const KDF_MAX_ITERATIONS = 5000000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
// Binds the ciphertext to this file format/version (authenticated, not secret).
const AAD = new TextEncoder().encode("ai-assistant-settings-secrets-v1");

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("Invalid encrypted data.");
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations, usage) {
  // NFKC so the same passphrase typed on different keyboards/OSes matches.
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(passphrase).normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

// `secrets` is a plain object of string values, e.g. { apiKey: "sk-..." }.
export async function encryptSecrets(secrets, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plaintext)
  );
  return {
    v: SECRETS_ENVELOPE_VERSION,
    kdf: KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(ciphertext),
  };
}

// Throws on a malformed envelope, a wrong passphrase, or a modified file.
export async function decryptSecrets(envelope, passphrase) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.v !== SECRETS_ENVELOPE_VERSION ||
    envelope.kdf !== KDF_NAME ||
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < KDF_MIN_ITERATIONS ||
    envelope.iterations > KDF_MAX_ITERATIONS
  ) {
    throw new Error("Unsupported encrypted settings format.");
  }
  let salt;
  let iv;
  let data;
  try {
    salt = base64ToBytes(envelope.salt);
    iv = base64ToBytes(envelope.iv);
    data = base64ToBytes(envelope.data);
  } catch {
    // The envelope is structurally genuine but its base64 payload is broken
    // (a lost character in a copy/paste throws inside atob): a distinct code
    // so the Settings page can say "damaged block" instead of "not a
    // settings backup".
    throw new Error("ENVELOPE_CORRUPT");
  }
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || data.length < 16) {
    throw new Error("Unsupported encrypted settings format.");
  }
  const key = await deriveKey(String(passphrase ?? ""), salt, envelope.iterations, "decrypt");
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, data);
  } catch {
    throw new Error("DECRYPT_FAILED");
  }
  // The passphrase was right and the ciphertext is authentic (GCM verified
  // every byte), but the decrypted plaintext is not valid JSON: the file was
  // damaged in a way authentication cannot see. A distinct error code so the
  // Settings page can say "the file is corrupt" instead of blaming the
  // passphrase or calling the whole file "not a settings backup".
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("PLAINTEXT_CORRUPT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Unsupported encrypted settings format.");
  return parsed;
}
