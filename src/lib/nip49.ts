/**
 * NIP-49 — password-encrypted private keys (`ncryptsec`).
 *
 * The payload is 91 bytes, bech32-encoded under the `ncryptsec` prefix:
 *
 *   version (0x02) | log_n | salt (16) | nonce (24) | key_security | ciphertext (48)
 *
 * The ciphertext is XChaCha20-Poly1305 over the raw 32-byte secret, keyed by
 * scrypt(password, salt, 2**log_n, r=8, p=1) and authenticating the
 * key-security byte as associated data, so a client cannot silently upgrade a
 * key's "handled insecurely" flag on a backup it did not make.
 *
 * This is deliberately not `nostr-tools`' `nip49`, which runs scrypt
 * synchronously and so blocks the main thread for 64–256 MiB of work — on a
 * phone that is a multi-second frozen tab. `scryptAsync` yields between blocks.
 * The two are byte-compatible; `nip49.test.ts` checks both directions.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { nip19 } from "nostr-tools";

const VERSION = 0x02;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
// 32-byte secret + 16-byte Poly1305 tag.
const CIPHERTEXT_LENGTH = 48;
const PAYLOAD_LENGTH = 1 + 1 + SALT_LENGTH + NONCE_LENGTH + 1 + CIPHERTEXT_LENGTH;
const SECRET_LENGTH = 32;
// 91 bytes encode to 146 words: 9-char prefix + 146 + 6-char checksum = 161.
const BECH32_LIMIT = 1024;

/**
 * scrypt cost. Decryption accepts up to 2**20 — the spec's table reaches 2**22,
 * but that is 4 GiB of memory, beyond any browser tab; 2**20 (1 GiB) is the
 * largest a client can plausibly honour and refusing the rest with a clear
 * error beats a tab that dies allocating it.
 */
const MIN_LOG_N = 14;
const MAX_LOG_N = 20;

/** 64 MiB and ~100 ms on a fast machine — what most NIP-49 clients write. */
export const DEFAULT_LOG_N = 16;

/**
 * How safely the key was handled before this backup existed, per NIP-49:
 * `insecure` = known to have been unencrypted somewhere, `secure` = not known
 * to have been, `unknown` = this client does not track it.
 */
export type KeySecurity = "insecure" | "secure" | "unknown";

const KEY_SECURITY_BYTES: Record<KeySecurity, number> = {
  insecure: 0x00,
  secure: 0x01,
  unknown: 0x02,
};

const SECURITY_BY_BYTE: Record<number, KeySecurity> = {
  0x00: "insecure",
  0x01: "secure",
};

/** The flag a single byte carries; anything else is a value this spec has not defined. */
function securityOf(byte: number | undefined): KeySecurity {
  return (byte !== undefined && SECURITY_BY_BYTE[byte]) || "unknown";
}

export interface NcryptsecHeader {
  logN: number;
  keySecurity: KeySecurity;
}

export interface EncryptOptions {
  logN?: number;
  keySecurity?: KeySecurity;
}

/** Thrown for a wrong password or a payload that failed authentication. */
export class NcryptsecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NcryptsecError";
  }
}

function decodePayload(ncryptsec: string): Uint8Array | null {
  try {
    const { prefix, words } = bech32.decode(ncryptsec.trim().toLowerCase(), BECH32_LIMIT);
    if (prefix !== "ncryptsec") return null;
    const payload = Uint8Array.from(bech32.fromWords(words));
    if (payload.length !== PAYLOAD_LENGTH) return null;
    if (payload[0] !== VERSION) return null;
    if (payload[1] < MIN_LOG_N || payload[1] > MAX_LOG_N) return null;
    return payload;
  } catch {
    return null;
  }
}

/** True for a well-formed `ncryptsec` this client can decrypt. Never throws. */
export function isNcryptsec(value: string): boolean {
  return decodePayload(value) !== null;
}

/** The backup's cost and key-security flag, or null if it is not a usable `ncryptsec`. */
export function readNcryptsec(value: string): NcryptsecHeader | null {
  const payload = decodePayload(value);
  if (!payload) return null;
  return {
    logN: payload[1],
    keySecurity: securityOf(payload[2 + SALT_LENGTH + NONCE_LENGTH]),
  };
}

function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new NcryptsecError("That is not a secret key.");
  const secret = decoded.data as Uint8Array;
  if (secret.length !== SECRET_LENGTH) throw new NcryptsecError("That secret key is the wrong length.");
  return secret;
}

function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

function deriveKey(password: string, salt: Uint8Array, logN: number): Promise<Uint8Array> {
  // NFKC so a password typed on another keyboard or OS derives the same key.
  return scryptAsync(password.normalize("NFKC"), salt, {
    N: 2 ** logN,
    r: 8,
    p: 1,
    dkLen: SECRET_LENGTH,
    // 128 * r * (N + p), plus headroom: noble's 1 GiB default would refuse 2**20.
    maxmem: 128 * 8 * (2 ** logN + 1) + 1024,
  });
}

/** Encrypt an `nsec` under a password, returning the portable `ncryptsec`. */
export async function encryptNsecToNcryptsec(
  nsec: string,
  password: string,
  options: EncryptOptions = {},
): Promise<string> {
  const logN = options.logN ?? DEFAULT_LOG_N;
  if (!Number.isInteger(logN) || logN < MIN_LOG_N || logN > MAX_LOG_N) {
    throw new NcryptsecError(`Unsupported scrypt cost ${logN}.`);
  }

  const secret = decodeNsec(nsec);
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const securityByte = KEY_SECURITY_BYTES[options.keySecurity ?? "unknown"];
  const associatedData = Uint8Array.from([securityByte]);

  let key: Uint8Array | undefined;
  try {
    key = await deriveKey(password, salt, logN);
    const ciphertext = xchacha20poly1305(key, nonce, associatedData).encrypt(secret);

    const payload = new Uint8Array(PAYLOAD_LENGTH);
    payload[0] = VERSION;
    payload[1] = logN;
    payload.set(salt, 2);
    payload.set(nonce, 2 + SALT_LENGTH);
    payload[2 + SALT_LENGTH + NONCE_LENGTH] = securityByte;
    payload.set(ciphertext, 2 + SALT_LENGTH + NONCE_LENGTH + 1);

    return bech32.encode("ncryptsec", bech32.toWords(payload), BECH32_LIMIT);
  } finally {
    if (key) wipe(key);
    wipe(secret);
  }
}

/**
 * Decrypt a `ncryptsec` back to an `nsec`. Throws {@link NcryptsecError} for a
 * wrong password, a corrupted payload, or a cost this client will not run.
 */
export async function decryptNcryptsecToNsec(ncryptsec: string, password: string): Promise<string> {
  const payload = decodePayload(ncryptsec);
  if (!payload) {
    throw new NcryptsecError(
      "That doesn't look like a valid encrypted key. Check you pasted the whole ncryptsec1… value.",
    );
  }

  const logN = payload[1];
  const salt = payload.slice(2, 2 + SALT_LENGTH);
  const nonce = payload.slice(2 + SALT_LENGTH, 2 + SALT_LENGTH + NONCE_LENGTH);
  const associatedData = payload.slice(2 + SALT_LENGTH + NONCE_LENGTH, 2 + SALT_LENGTH + NONCE_LENGTH + 1);
  const ciphertext = payload.slice(2 + SALT_LENGTH + NONCE_LENGTH + 1);

  let key: Uint8Array | undefined;
  try {
    key = await deriveKey(password, salt, logN);
    const secret = xchacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
    // Copy out of the payload-backed buffer before the caller keeps the string.
    const nsec = nip19.nsecEncode(secret);
    wipe(secret);
    return nsec;
  } catch (error) {
    if (error instanceof NcryptsecError) throw error;
    throw new NcryptsecError("Wrong password for this backup.");
  } finally {
    if (key) wipe(key);
  }
}

/**
 * The key-security flag to write into a backup made on this device: the web
 * build keeps the login in plain localStorage, so a key that has lived there
 * has been stored unencrypted and is honestly `insecure`; the OS keystore and
 * Electron `safeStorage` are `secure` only when the store is actually in use.
 */
export function keySecurityFor(
  storage: "os-keystore" | "safe-storage" | "plaintext" | "unknown",
): KeySecurity {
  switch (storage) {
    case "os-keystore":
    case "safe-storage":
      return "secure";
    case "plaintext":
      return "insecure";
    default:
      return "unknown";
  }
}
