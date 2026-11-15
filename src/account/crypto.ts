/**
 * Client-side account cryptography: everything that touches a password, a
 * recovery code or a Nostr secret key happens here, on the device.
 *
 *   password ──scrypt(salt)──► master ──HKDF──► authKey   (sent to the server)
 *                                      └─HKDF──► vaultKey  (never leaves)
 *
 * The server sees `authKey` only, and one HKDF output says nothing about
 * another, so what it holds cannot open the vault.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  INFO,
  KDF_V1,
  KEY_BYTES,
  SALT_BYTES,
  VAULT_BYTES,
  VAULT_PLAINTEXT_BYTES,
  isHex,
  type KdfParams,
  type RecoveryBundle,
  type VaultContents,
} from "./protocol";

const VAULT_VERSION = 1;
const NONCE_BYTES = 24;
/** Crockford base32: no I, L, O or U, so a code read aloud or retyped survives. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 5;

export interface DerivedKeys {
  /** hex; the only password-derived value the server ever sees. */
  authKey: string;
  vaultKey: Uint8Array;
}

export function newSalt(): string {
  return bytesToHex(randomBytes(SALT_BYTES));
}

async function stretch(secret: string, saltHex: string, kdf: KdfParams): Promise<Uint8Array> {
  if (!isHex(saltHex, SALT_BYTES)) throw new Error("bad salt");
  // The server names the cost, so refuse one weak enough to make guessing cheap.
  if (kdf.n < KDF_V1.n || kdf.r < KDF_V1.r || kdf.p < 1 || kdf.n > 2 ** 20) throw new Error("bad kdf");
  return scryptAsync(utf8ToBytes(secret.normalize("NFKC")), hexToBytes(saltHex), {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    dkLen: KEY_BYTES,
  });
}

function expand(master: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, master, undefined, utf8ToBytes(info), KEY_BYTES);
}

/** The two keys a password yields for one account salt. */
export async function deriveKeys(password: string, saltHex: string, kdf: KdfParams = KDF_V1): Promise<DerivedKeys> {
  const master = await stretch(password, saltHex, kdf);
  return { authKey: bytesToHex(expand(master, INFO.auth)), vaultKey: expand(master, INFO.vault) };
}

/** Seal a Nostr secret key under a vault key. The output length is fixed. */
export function sealVault(vaultKey: Uint8Array, contents: VaultContents): string {
  if (!isHex(contents.sk, 32)) throw new Error("bad secret key");
  const body = utf8ToBytes(JSON.stringify({ sk: contents.sk }));
  if (body.length > VAULT_PLAINTEXT_BYTES - 2) throw new Error("vault contents too large");
  const padded = new Uint8Array(VAULT_PLAINTEXT_BYTES);
  padded[0] = body.length >> 8;
  padded[1] = body.length & 0xff;
  padded.set(body, 2);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = utf8ToBytes(INFO.vault);
  const sealed = xchacha20poly1305(vaultKey, nonce, aad).encrypt(padded);
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = VAULT_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return bytesToHex(out);
}

/** Open a vault. Throws on a wrong key or a tampered vault; never returns garbage. */
export function openVault(vaultKey: Uint8Array, vaultHex: string): VaultContents {
  if (!isHex(vaultHex, VAULT_BYTES)) throw new Error("bad vault");
  const bytes = hexToBytes(vaultHex);
  if (bytes[0] !== VAULT_VERSION) throw new Error("unknown vault version");
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const padded = xchacha20poly1305(vaultKey, nonce, utf8ToBytes(INFO.vault)).decrypt(bytes.subarray(1 + NONCE_BYTES));
  const length = (padded[0] << 8) | padded[1];
  if (length > VAULT_PLAINTEXT_BYTES - 2) throw new Error("bad vault");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(padded.subarray(2, 2 + length)));
  const sk = (parsed as { sk?: unknown } | null)?.sk;
  if (!isHex(sk, 32)) throw new Error("bad vault");
  return { sk };
}

/** A fresh recovery code: 100 random bits as `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function newRecoveryCode(): string {
  const total = CODE_GROUPS * CODE_GROUP_LENGTH;
  const bytes = randomBytes(total);
  let code = "";
  for (let i = 0; i < total; i += 1) {
    if (i > 0 && i % CODE_GROUP_LENGTH === 0) code += "-";
    // 32 symbols divide 256 evenly, so the low five bits are unbiased.
    code += CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

/** What the person typed, as the code that was shown: case, spacing, dashes and look-alikes forgiven. */
export function normalizeRecoveryCode(input: string): string | null {
  const flat = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (flat.length !== CODE_GROUPS * CODE_GROUP_LENGTH) return null;
  for (const char of flat) if (!CODE_ALPHABET.includes(char)) return null;
  return flat.match(new RegExp(`.{${CODE_GROUP_LENGTH}}`, "g"))!.join("-");
}

export interface RecoveryKeys {
  auth: string;
  vaultKey: Uint8Array;
}

export async function deriveRecoveryKeys(code: string, saltHex: string, kdf: KdfParams = KDF_V1): Promise<RecoveryKeys> {
  const normal = normalizeRecoveryCode(code);
  if (!normal) throw new Error("bad recovery code");
  const master = await stretch(normal, saltHex, kdf);
  return { auth: bytesToHex(expand(master, INFO.recoveryAuth)), vaultKey: expand(master, INFO.recoveryVault) };
}

/** A new recovery code and the bundle the server stores for it. The code itself is shown once and kept nowhere. */
export async function createRecovery(contents: VaultContents, kdf: KdfParams = KDF_V1): Promise<{ code: string; bundle: RecoveryBundle }> {
  const code = newRecoveryCode();
  const salt = newSalt();
  const keys = await deriveRecoveryKeys(code, salt, kdf);
  return { code, bundle: { salt, auth: keys.auth, vault: sealVault(keys.vaultKey, contents) } };
}
