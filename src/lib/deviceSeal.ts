/**
 * Sealing for the login list at rest on the web build.
 *
 * `armada:login` holds nsecs, and on the web it was written to localStorage as
 * plaintext — readable by anything that copies a browser profile: a backup, a
 * profile sync, a disk image, another process reading the profile directory.
 *
 * There is no password to derive a key from at boot (the account session keeps
 * only a token on disk and the vault key in memory), so the wrapping key has to
 * be one this device can use without asking: an AES-GCM-256 key generated
 * `extractable: false`, kept in IndexedDB. The browser stores it wrapped by the
 * OS keystore and no script can export it.
 *
 * It stops the nsec being read out of a copied profile, a storage dump or a
 * disk backup. It does NOT stop script running on this origin while the tab is
 * open (XSS reads whatever the app reads), or someone at the unlocked device
 * with a console. Only a password per session would, and that would mean
 * signing in again on every reload.
 *
 * Every failure here is a `null`, and the caller then stores plaintext: an
 * unavailable key must never cost somebody their login.
 */

const DB_NAME = "wizardry-seal";
const STORE_NAME = "keys";
const KEY_ID = "login-seal-v1";
const IV_BYTES = 12;

export interface DeviceEnvelope {
  v: 1;
  enc: "device";
  data: string;
}

/** The sealed shape, or null for anything else (plaintext, another envelope). */
export function parseDeviceEnvelope(value: string): DeviceEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<DeviceEnvelope>;
    if (parsed?.v === 1 && parsed.enc === "device" && typeof parsed.data === "string") {
      return parsed as DeviceEnvelope;
    }
  } catch {
    // Not JSON: plaintext from before sealing existed.
  }
  return null;
}

function subtleOrNull(): SubtleCrypto | null {
  return typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function readStoredKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(KEY_ID);
    request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

function writeStoredKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(key, KEY_ID);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * One key per browser profile. Cached for the session; a miss or a failure
 * clears the cache so a later attempt can retry instead of staying broken.
 */
let keyPromise: Promise<CryptoKey | null> | null = null;

async function resolveKey(create: boolean): Promise<CryptoKey | null> {
  const subtle = subtleOrNull();
  if (!subtle || typeof indexedDB === "undefined") return null;

  const db = await openDatabase();
  const existing = await readStoredKey(db);
  if (existing) return existing;
  if (!create) return null;

  const generated = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await writeStoredKey(db, generated);
  return generated;
}

function loadKey(create: boolean): Promise<CryptoKey | null> {
  keyPromise ??= resolveKey(create).catch(() => {
    keyPromise = null;
    return null;
  });
  return keyPromise;
}

/**
 * Seal plaintext for storage. Returns the JSON envelope, or null when this
 * browser cannot seal (no SubtleCrypto, no IndexedDB, private mode).
 */
export async function sealText(plaintext: string): Promise<string | null> {
  try {
    const subtle = subtleOrNull();
    const key = await loadKey(true);
    if (!subtle || !key) return null;

    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
    );
    const packed = new Uint8Array(iv.length + ciphertext.length);
    packed.set(iv, 0);
    packed.set(ciphertext, iv.length);

    const envelope: DeviceEnvelope = { v: 1, enc: "device", data: bytesToBase64(packed) };
    return JSON.stringify(envelope);
  } catch {
    return null;
  }
}

/**
 * Open a sealed envelope. Null means "cannot read this": no key, a different
 * profile's key, or a tampered payload — the caller must treat that as locked
 * rather than empty, because the nsec inside may be the only copy.
 */
export async function unsealText(sealed: string): Promise<string | null> {
  const envelope = parseDeviceEnvelope(sealed);
  if (!envelope) return null;

  try {
    const subtle = subtleOrNull();
    // Never generate here: a fresh key would only fail to open this payload.
    const key = await loadKey(false);
    if (!subtle || !key) return null;

    const packed = base64ToBytes(envelope.data);
    if (packed.length <= IV_BYTES) return null;

    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, IV_BYTES) },
      key,
      packed.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
