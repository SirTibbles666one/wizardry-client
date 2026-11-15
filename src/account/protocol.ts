/**
 * The Wizardry account protocol, shared by the client and the account server.
 * Design and threat model: docs/accounts.md.
 *
 * The server never receives a password, a Nostr secret key or a Nostr public
 * key in a form it can keep: it stores a peppered hash of the email, a peppered
 * hash of a password-derived key, a vault only the password opens, and (in a
 * table with no account column) a peppered hash of each linked public key.
 */

/** scrypt cost for password and recovery-code stretching. NIP-49's default is the same 2^16. */
export interface KdfParams {
  n: number;
  r: number;
  p: number;
}

export const KDF_V1: KdfParams = { n: 2 ** 16, r: 8, p: 1 };

/** HKDF `info` labels. Changing one makes every existing account unreadable. */
export const INFO = {
  auth: "wizardry/auth/v1",
  vault: "wizardry/vault/v1",
  recoveryAuth: "wizardry/recovery-auth/v1",
  recoveryVault: "wizardry/recovery-vault/v1",
} as const;

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
/** A sealed vault is always this long, so its size says nothing about what it holds. */
export const VAULT_PLAINTEXT_BYTES = 256;
/** version(1) + nonce(24) + ciphertext(256) + tag(16). */
export const VAULT_BYTES = 1 + 24 + VAULT_PLAINTEXT_BYTES + 16;

/** NIP-98 HTTP auth: the event a key signs to prove it is being linked by its holder. */
export const KEY_PROOF_KIND = 27235;
export const KEY_PROOF_MAX_SKEW_SECS = 120;

export const EMAIL_CODE_DIGITS = 6;

/** What a vault holds. `sk` is the 32-byte Nostr secret key, hex. */
export interface VaultContents {
  sk: string;
}

/** The recovery half of a stored key: a second copy of the vault under the recovery code. */
export interface RecoveryBundle {
  /** hex, {@link SALT_BYTES}. */
  salt: string;
  /** hex, {@link KEY_BYTES}: proves knowledge of the code without revealing it. */
  auth: string;
  /** hex, {@link VAULT_BYTES}. */
  vault: string;
}

export interface PreloginResponse {
  salt: string;
  kdf: KdfParams;
}

export interface SessionResponse {
  token: string;
  /** hex vault, or null when the account has no stored key (extension, signer, or not set up yet). */
  vault: string | null;
  hasRecovery: boolean;
  keyLinked: boolean;
}

export interface RecoveryOpenResponse {
  salt: string;
  vault: string;
  resetToken: string;
}

/** Error codes the server answers with; the client maps them to translated text. */
export type AccountErrorCode =
  | "bad_request"
  | "invalid_credentials"
  | "unverified"
  | "invalid_code"
  | "rate_limited"
  | "unauthorized"
  | "invalid_proof"
  | "no_recovery"
  | "not_found"
  | "mail_failed"
  | "network";

export const HEX = /^[0-9a-f]+$/;

export function isHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length === bytes * 2 && HEX.test(value);
}

/** One spelling of an address: trimmed, NFKC, lowercased. Null when it is not shaped like one. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.normalize("NFKC").trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/.test(email)) return null;
  return email;
}
