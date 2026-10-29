#!/usr/bin/env node
// Unit tests for settings-crypto.js: passphrase encryption/decryption of API secrets.
// Run:  node scripts/test-settings-crypto.mjs
import assert from "node:assert/strict";
import {
  encryptSecrets,
  decryptSecrets,
  MIN_PASSPHRASE_LENGTH,
  SECRETS_ENVELOPE_VERSION,
} from "../settings-crypto.js";

const sampleSecrets = {
  apiKey: "sk-test-deepseek-1234567890",
  groqApiKey: "gsk_test_groq_0987654321",
  openrouterApiKey: "sk-or-v1-abcdef",
  tavilyApiKey: "tvly-test-112233",
};

const validPassphrase = "correct horse battery staple 123";

// ---------- 1. Passphrase validation ----------
await assert.rejects(
  encryptSecrets(sampleSecrets, "short"),
  new RegExp(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`),
  "passphrase shorter than minimum rejected"
);
await assert.rejects(
  encryptSecrets(sampleSecrets, ""),
  new RegExp(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`),
  "empty passphrase rejected"
);

// ---------- 2. Happy path: encrypt & decrypt round trip ----------
const envelope = await encryptSecrets(sampleSecrets, validPassphrase);
assert.equal(envelope.v, SECRETS_ENVELOPE_VERSION, "envelope version matches");
assert.equal(envelope.kdf, "PBKDF2-SHA256", "kdf matches");
assert.ok(typeof envelope.salt === "string" && envelope.salt.length > 0, "salt is base64");
assert.ok(typeof envelope.iv === "string" && envelope.iv.length > 0, "iv is base64");
assert.ok(typeof envelope.data === "string" && envelope.data.length > 0, "data is base64");

const decrypted = await decryptSecrets(envelope, validPassphrase);
assert.deepEqual(decrypted, sampleSecrets, "decrypted object matches original secrets");

// ---------- 3. Wrong passphrase fails with DECRYPT_FAILED ----------
await assert.rejects(
  decryptSecrets(envelope, "wrong passphrase but long enough"),
  (err) => err?.message === "DECRYPT_FAILED",
  "wrong passphrase throws DECRYPT_FAILED"
);

// ---------- 4. Corrupted ciphertext fails with DECRYPT_FAILED ----------
const corruptedEnvelope = {
  ...envelope,
  data: envelope.data.slice(0, -4) + "AAAA",
};
await assert.rejects(
  decryptSecrets(corruptedEnvelope, validPassphrase),
  (err) => err?.message === "DECRYPT_FAILED",
  "corrupted ciphertext throws DECRYPT_FAILED"
);

// ---------- 5. Envelope integrity checks ----------
await assert.rejects(
  decryptSecrets({ ...envelope, v: 999 }, validPassphrase),
  /Unsupported encrypted settings format/
);
await assert.rejects(
  decryptSecrets({ ...envelope, kdf: "MD5" }, validPassphrase),
  /Unsupported encrypted settings format/
);
await assert.rejects(
  decryptSecrets({ ...envelope, iterations: 50 }, validPassphrase),
  /Unsupported encrypted settings format/
);

console.log("OK: settings-crypto.js — passphrase validation, encrypt/decrypt round trip, auth tag verification, envelope guards.");
process.exit(0);
