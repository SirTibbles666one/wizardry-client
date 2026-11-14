/**
 * The account server's rules, with no I/O of its own: a store, a mailer and a
 * clock are handed in, so the suite runs the code that ships (`main.ts` adds
 * HTTP, SQLite and SMTP around it). Design and threat model: docs/accounts.md.
 *
 * What a row can and cannot say:
 * - An account is keyed by HMAC(pepper, email). The address itself is used once,
 *   in memory, to send a code, and is never stored or logged.
 * - The password never arrives. `authKey` is one HKDF branch of the stretched
 *   password and is stored only as HMAC(pepper, salt ‖ authKey).
 * - The vault is ciphertext under the other branch, which never arrives either.
 * - A linked Nostr key is stored as HMAC(pepper, pubkey) in a table with NO
 *   account column, dated to the day. A copy of the database alone does not say
 *   which account holds which key, or list any key at all.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";

import {
  EMAIL_CODE_DIGITS,
  KDF_V1,
  KEY_BYTES,
  KEY_PROOF_KIND,
  KEY_PROOF_MAX_SKEW_SECS,
  SALT_BYTES,
  VAULT_BYTES,
  isHex,
  normalizeEmail,
  type AccountErrorCode,
  type PreloginResponse,
  type RecoveryBundle,
  type RecoveryOpenResponse,
  type SessionResponse,
} from "../protocol";

export interface AccountRow {
  emailHash: string;
  /** Client KDF salt, hex. Public by design: prelogin hands it to anyone who asks. */
  salt: string;
  verifierSalt: string;
  verifier: string;
  verified: boolean;
  vault: string | null;
  recoverySalt: string | null;
  recoveryVerifier: string | null;
  recoveryVault: string | null;
  keyLinked: boolean;
  /** Days since the epoch: when it was made, to the day and no finer. */
  createdDay: number;
}

export type CodePurpose = "verify" | "recover";

export interface CodeRow {
  emailHash: string;
  purpose: CodePurpose;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export type TokenKind = "session" | "reset";

export interface TokenRow {
  tokenHash: string;
  kind: TokenKind;
  emailHash: string;
  expiresAt: number;
}

/** Storage. Synchronous: SQLite's driver is, and it keeps each request atomic without transactions. */
export interface AccountStore {
  getAccount(emailHash: string): AccountRow | null;
  putAccount(row: AccountRow): void;
  deleteAccount(emailHash: string): void;
  getCode(emailHash: string, purpose: CodePurpose): CodeRow | null;
  putCode(row: CodeRow): void;
  deleteCode(emailHash: string, purpose: CodePurpose): void;
  getToken(tokenHash: string): TokenRow | null;
  putToken(row: TokenRow): void;
  deleteToken(tokenHash: string): void;
  deleteTokensFor(emailHash: string): void;
  hasKeyHash(keyHash: string): boolean;
  putKeyHash(keyHash: string, day: number): void;
  deleteKeyHash(keyHash: string): void;
  /** Drop expired codes and tokens. */
  sweep(now: number): void;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface AccountDeps {
  store: AccountStore;
  /** 32 secret bytes. Without it the hashes in the database cannot be checked or guessed at. */
  pepper: Uint8Array;
  sendMail(mail: Mail): Promise<void>;
  /** Milliseconds. */
  now(): number;
  /** The server's public base URL, as a key proof must name it. */
  publicUrl: string;
  appName: string;
  /** Shared secret a relay presents to ask whether a key is a member's. Empty disables the check. */
  memberToken?: string;
  random?: (bytes: number) => Uint8Array;
}

export interface AccountRequest {
  /** Path after `/v1/`, e.g. `login`. */
  route: string;
  body: unknown;
  bearer?: string;
  /** Caller address, for rate limiting only; never stored. */
  ip: string;
  memberToken?: string;
}

export interface AccountResponse {
  status: number;
  body: Record<string, unknown>;
}

const CODE_TTL_MS = 15 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 86_400_000;
const RESET_TTL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

class Refusal extends Error {
  constructor(readonly status: number, readonly code: AccountErrorCode) {
    super(code);
  }
}

const refuse = (status: number, code: AccountErrorCode): never => {
  throw new Refusal(status, code);
};

/** Fixed-window limiter, in memory: a restart forgives everyone, which is fine for what it guards. */
class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  allow(key: string, limit: number, windowMs: number, now: number): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > 50_000) this.prune(now, windowMs);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, entry] of this.hits) if (now - entry.windowStart >= windowMs) this.hits.delete(key);
  }
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

export function createAccountServer(deps: AccountDeps) {
  const { store, pepper } = deps;
  if (pepper.length < 32) throw new Error("ACCOUNT_PEPPER must be at least 32 bytes");
  const random = deps.random ?? randomBytes;
  const limiter = new RateLimiter();
  const publicUrl = deps.publicUrl.replace(/\/+$/, "");

  const tag = (label: string, ...parts: string[]) =>
    bytesToHex(hmac(sha256, pepper, concatBytes(utf8ToBytes(`${label}\n`), utf8ToBytes(parts.join("\n")))));
  const emailHashOf = (email: string) => tag("email", email);
  const verifierOf = (salt: string, authKey: string) => tag("auth", salt, authKey);
  const codeHashOf = (emailHash: string, purpose: CodePurpose, code: string) => tag("code", emailHash, purpose, code);
  const tokenHashOf = (token: string) => tag("token", token);
  const keyHashOf = (pubkey: string) => tag("key", pubkey);
  const newHex = (bytes: number) => bytesToHex(random(bytes));

  /** What prelogin answers for an address with no account: stable per address, so it reads like a real one. */
  const decoySalt = (emailHash: string) => tag("decoy-salt", emailHash).slice(0, SALT_BYTES * 2);

  function limit(key: string, max: number, windowMs: number): void {
    if (!limiter.allow(key, max, windowMs, deps.now())) refuse(429, "rate_limited");
  }

  function emailOf(body: unknown): { email: string; emailHash: string } {
    const email = normalizeEmail(field(body, "email"));
    if (!email) return refuse(400, "bad_request");
    return { email, emailHash: emailHashOf(email) };
  }

  function hexField(body: unknown, name: string, bytes: number): string {
    const value = field(body, name);
    if (!isHex(value, bytes)) return refuse(400, "bad_request");
    return value;
  }

  function recoveryOf(body: unknown): RecoveryBundle | null {
    const raw = field(body, "recovery");
    if (raw === undefined || raw === null) return null;
    return { salt: hexField(raw, "salt", SALT_BYTES), auth: hexField(raw, "auth", KEY_BYTES), vault: hexField(raw, "vault", VAULT_BYTES) };
  }

  function newCode(): string {
    // Rejection sampling over four bytes: no modulo bias in a six-digit code.
    const span = 10 ** EMAIL_CODE_DIGITS;
    const ceiling = Math.floor(0x1_0000_0000 / span) * span;
    for (;;) {
      const bytes = random(4);
      const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      if (value < ceiling) return String(value % span).padStart(EMAIL_CODE_DIGITS, "0");
    }
  }

  async function mailCode(email: string, emailHash: string, purpose: CodePurpose): Promise<void> {
    const code = newCode();
    store.putCode({ emailHash, purpose, codeHash: codeHashOf(emailHash, purpose, code), expiresAt: deps.now() + CODE_TTL_MS, attempts: 0 });
    const subject = purpose === "verify" ? `${code} is your ${deps.appName} code` : `${code} is your ${deps.appName} recovery code`;
    const text = purpose === "verify"
      ? `Your ${deps.appName} confirmation code is ${code}.\n\nIt works for 15 minutes. If you did not ask for it, ignore this message: nothing has been created.\n`
      : `Your ${deps.appName} recovery code is ${code}.\n\nIt works for 15 minutes, and only together with the recovery code you saved when you made your account. If you did not ask for it, ignore this message.\n`;
    try {
      await deps.sendMail({ to: email, subject, text });
    } catch {
      refuse(502, "mail_failed");
    }
  }

  function takeCode(emailHash: string, purpose: CodePurpose, code: unknown): void {
    const row = store.getCode(emailHash, purpose);
    if (!row || row.expiresAt <= deps.now() || typeof code !== "string") return refuse(400, "invalid_code");
    if (row.attempts >= CODE_MAX_ATTEMPTS) {
      store.deleteCode(emailHash, purpose);
      return refuse(400, "invalid_code");
    }
    if (!equalHex(row.codeHash, codeHashOf(emailHash, purpose, code.trim()))) {
      store.putCode({ ...row, attempts: row.attempts + 1 });
      return refuse(400, "invalid_code");
    }
    store.deleteCode(emailHash, purpose);
  }

  function issue(kind: TokenKind, emailHash: string, ttl: number): string {
    const token = newHex(32);
    store.putToken({ tokenHash: tokenHashOf(token), kind, emailHash, expiresAt: deps.now() + ttl });
    return token;
  }

  function redeem(kind: TokenKind, token: unknown): { row: TokenRow; account: AccountRow } {
    if (!isHex(token, 32)) return refuse(401, "unauthorized");
    const row = store.getToken(tokenHashOf(token));
    if (!row || row.kind !== kind || row.expiresAt <= deps.now()) return refuse(401, "unauthorized");
    const account = store.getAccount(row.emailHash);
    if (!account) return refuse(401, "unauthorized");
    return { row, account };
  }

  const session = (request: AccountRequest) => redeem("session", request.bearer).account;

  function sessionResponse(account: AccountRow): SessionResponse {
    return {
      token: issue("session", account.emailHash, SESSION_TTL_MS),
      vault: account.vault,
      hasRecovery: account.recoveryVerifier !== null,
      keyLinked: account.keyLinked,
    };
  }

  function withPassword(account: AccountRow, salt: string, authKey: string): AccountRow {
    const verifierSalt = newHex(SALT_BYTES);
    return { ...account, salt, verifierSalt, verifier: verifierOf(verifierSalt, authKey) };
  }

  function withRecovery(account: AccountRow, bundle: RecoveryBundle | null): AccountRow {
    if (!bundle) return { ...account, recoverySalt: null, recoveryVerifier: null, recoveryVault: null };
    return { ...account, recoverySalt: bundle.salt, recoveryVerifier: verifierOf(bundle.salt, bundle.auth), recoveryVault: bundle.vault };
  }

  /** The pubkey a NIP-98 event proves its sender holds, for one route of this server. */
  function provenKey(body: unknown, route: string): string {
    const event = field(body, "event") as NostrEvent | undefined;
    if (!event || typeof event !== "object" || event.kind !== KEY_PROOF_KIND || !Array.isArray(event.tags)) return refuse(400, "invalid_proof");
    const tagValue = (name: string) => event.tags.find((entry) => Array.isArray(entry) && entry[0] === name)?.[1];
    if (tagValue("u") !== `${publicUrl}/v1/${route}` || String(tagValue("method")).toUpperCase() !== "POST") return refuse(400, "invalid_proof");
    if (Math.abs(deps.now() / 1000 - Number(event.created_at)) > KEY_PROOF_MAX_SKEW_SECS) return refuse(400, "invalid_proof");
    let valid = false;
    try {
      valid = verifyEvent(event);
    } catch {
      valid = false;
    }
    if (!valid || !isHex(event.pubkey, 32)) return refuse(400, "invalid_proof");
    return event.pubkey;
  }

  const routes: Record<string, (request: AccountRequest) => Promise<Record<string, unknown>> | Record<string, unknown>> = {
    /** The salt to stretch a password with. Answers for every address, so it reveals no account. */
    prelogin({ body, ip }) {
      limit(`prelogin:${ip}`, 30, 60_000);
      const { emailHash } = emailOf(body);
      const account = store.getAccount(emailHash);
      const answer: PreloginResponse = { salt: account?.salt ?? decoySalt(emailHash), kdf: KDF_V1 };
      return { ...answer };
    },

    async signup({ body, ip }) {
      limit(`signup:${ip}`, 5, 3_600_000);
      const { email, emailHash } = emailOf(body);
      limit(`signup-mail:${emailHash}`, 3, 3_600_000);
      const salt = hexField(body, "salt", SALT_BYTES);
      const authKey = hexField(body, "authKey", KEY_BYTES);
      const existing = store.getAccount(emailHash);
      if (existing?.verified) {
        // Same answer as a new address; the owner is told by mail instead, so the form cannot be used to look people up.
        try {
          await deps.sendMail({
            to: email,
            subject: `You already have a ${deps.appName} account`,
            text: `Someone tried to make a ${deps.appName} account with this address, and it already has one.\n\nIf that was you, sign in instead. If you have lost your password, choose "Forgot password" on the sign-in page.\n`,
          });
        } catch {
          refuse(502, "mail_failed");
        }
        return { ok: true };
      }
      const fresh: AccountRow = {
        emailHash, salt, verifierSalt: "", verifier: "", verified: false, vault: null,
        recoverySalt: null, recoveryVerifier: null, recoveryVault: null, keyLinked: false,
        createdDay: Math.floor(deps.now() / DAY_MS),
      };
      store.putAccount(withPassword(fresh, salt, authKey));
      await mailCode(email, emailHash, "verify");
      return { ok: true };
    },

    /** Confirm the address. Needs the password's key too, so a code read off a shoulder is not an account. */
    verify({ body, ip }) {
      limit(`verify:${ip}`, 20, 600_000);
      const { emailHash } = emailOf(body);
      const authKey = hexField(body, "authKey", KEY_BYTES);
      const account = store.getAccount(emailHash);
      if (!account || account.verified || !equalHex(account.verifier, verifierOf(account.verifierSalt, authKey))) return refuse(400, "invalid_code");
      takeCode(emailHash, "verify", field(body, "code"));
      const verified = { ...account, verified: true };
      store.putAccount(verified);
      return { ...sessionResponse(verified) };
    },

    login({ body, ip }) {
      limit(`login:${ip}`, 20, 600_000);
      const { emailHash } = emailOf(body);
      limit(`login:${emailHash}`, 10, 600_000);
      const authKey = hexField(body, "authKey", KEY_BYTES);
      const account = store.getAccount(emailHash);
      // Compare against a dummy when there is no account, so both paths cost the same.
      const expected = account?.verifier ?? verifierOf("", "");
      const given = verifierOf(account?.verifierSalt ?? "", authKey);
      if (!equalHex(expected, given) || !account) return refuse(401, "invalid_credentials");
      if (!account.verified) return refuse(403, "unverified");
      return { ...sessionResponse(account) };
    },

    logout({ bearer }) {
      if (isHex(bearer, 32)) store.deleteToken(tokenHashOf(bearer));
      return { ok: true };
    },

    /** Store (or replace) the locked key and its recovery copy. Omitting the vault clears both. */
    "vault/put"(request) {
      const account = session(request);
      const vault = field(request.body, "vault");
      if (vault === null) {
        store.putAccount(withRecovery({ ...account, vault: null }, null));
        return { ok: true };
      }
      const bundle = recoveryOf(request.body);
      const next = { ...account, vault: hexField(request.body, "vault", VAULT_BYTES) };
      // A new vault without a new recovery copy would leave the old copy opening the OLD key.
      store.putAccount(withRecovery(next, bundle));
      return { ok: true, hasRecovery: bundle !== null };
    },

    /** Record that a key belongs to a member. The hash goes in a table that does not name the account. */
    "key/link"(request) {
      const account = session(request);
      const pubkey = provenKey(request.body, "key/link");
      store.putKeyHash(keyHashOf(pubkey), Math.floor(deps.now() / DAY_MS));
      if (!account.keyLinked) store.putAccount({ ...account, keyLinked: true });
      return { ok: true };
    },

    "key/unlink"(request) {
      const account = session(request);
      const pubkey = provenKey(request.body, "key/unlink");
      store.deleteKeyHash(keyHashOf(pubkey));
      store.putAccount({ ...account, keyLinked: false });
      return { ok: true };
    },

    "password/change"(request) {
      const account = session(request);
      const current = hexField(request.body, "authKey", KEY_BYTES);
      if (!equalHex(account.verifier, verifierOf(account.verifierSalt, current))) return refuse(401, "invalid_credentials");
      const salt = hexField(request.body, "newSalt", SALT_BYTES);
      const next = withPassword(account, salt, hexField(request.body, "newAuthKey", KEY_BYTES));
      // The vault key changes with the password, so the vault must be re-sealed in the same request.
      const vault = account.vault === null ? null : hexField(request.body, "vault", VAULT_BYTES);
      store.putAccount({ ...next, vault });
      store.deleteTokensFor(account.emailHash);
      return { ...sessionResponse({ ...next, vault }) };
    },

    async "recover/start"({ body, ip }) {
      limit(`recover:${ip}`, 5, 3_600_000);
      const { email, emailHash } = emailOf(body);
      limit(`recover-mail:${emailHash}`, 3, 3_600_000);
      const account = store.getAccount(emailHash);
      // Mail only a real, confirmed account; answer the same either way.
      if (account?.verified) await mailCode(email, emailHash, "recover");
      return { ok: true };
    },

    /** Emailed code + proof of the recovery code → the recovery copy of the vault, and leave to set a new password. */
    "recover/open"({ body, ip }) {
      limit(`recover-open:${ip}`, 20, 600_000);
      const { emailHash } = emailOf(body);
      const auth = hexField(body, "recoveryAuth", KEY_BYTES);
      const account = store.getAccount(emailHash);
      if (!account?.verified) return refuse(400, "invalid_code");
      if (!account.recoveryVerifier || !account.recoverySalt || !account.recoveryVault) return refuse(400, "no_recovery");
      if (!equalHex(account.recoveryVerifier, verifierOf(account.recoverySalt, auth))) {
        // Count the miss against the emailed code, so the recovery code cannot be guessed at without limit.
        const row = store.getCode(emailHash, "recover");
        if (row) store.putCode({ ...row, attempts: row.attempts + 1 });
        return refuse(400, "invalid_code");
      }
      takeCode(emailHash, "recover", field(body, "code"));
      const answer: RecoveryOpenResponse = { salt: account.recoverySalt, vault: account.recoveryVault, resetToken: issue("reset", emailHash, RESET_TTL_MS) };
      return { ...answer };
    },

    /** The salt a recovery code is stretched with. Like prelogin, it answers for every address. */
    "recover/salt"({ body, ip }) {
      limit(`recover-salt:${ip}`, 30, 60_000);
      const { emailHash } = emailOf(body);
      return { salt: store.getAccount(emailHash)?.recoverySalt ?? tag("decoy-recovery", emailHash).slice(0, SALT_BYTES * 2), kdf: KDF_V1 };
    },

    "recover/reset"({ body }) {
      const { row, account } = redeem("reset", field(body, "resetToken"));
      const bundle = recoveryOf(body);
      if (!bundle) return refuse(400, "bad_request");
      const salt = hexField(body, "salt", SALT_BYTES);
      const next = withRecovery({ ...withPassword(account, salt, hexField(body, "authKey", KEY_BYTES)), vault: hexField(body, "vault", VAULT_BYTES) }, bundle);
      store.putAccount(next);
      store.deleteToken(row.tokenHash);
      store.deleteTokensFor(account.emailHash);
      return { ...sessionResponse(next) };
    },

    /**
     * Forgot the password AND lost the recovery code: the emailed code alone keeps
     * the account but empties it. The old key is gone for good, which is the price
     * of a server that cannot read it.
     */
    "recover/start-over"({ body, ip }) {
      limit(`recover-open:${ip}`, 20, 600_000);
      const { emailHash } = emailOf(body);
      const account = store.getAccount(emailHash);
      if (!account?.verified) return refuse(400, "invalid_code");
      takeCode(emailHash, "recover", field(body, "code"));
      const salt = hexField(body, "salt", SALT_BYTES);
      const next = withRecovery({ ...withPassword(account, salt, hexField(body, "authKey", KEY_BYTES)), vault: null, keyLinked: false }, null);
      store.putAccount(next);
      store.deleteTokensFor(emailHash);
      return { ...sessionResponse(next) };
    },

    "account/delete"(request) {
      const account = session(request);
      const authKey = hexField(request.body, "authKey", KEY_BYTES);
      if (!equalHex(account.verifier, verifierOf(account.verifierSalt, authKey))) return refuse(401, "invalid_credentials");
      store.deleteTokensFor(account.emailHash);
      store.deleteCode(account.emailHash, "verify");
      store.deleteCode(account.emailHash, "recover");
      store.deleteAccount(account.emailHash);
      return { ok: true };
    },

    /** For a relay that admits members only: is this key a member's? Needs the shared secret; names no account. */
    "member/check"({ body, memberToken, ip }) {
      limit(`member:${ip}`, 600, 60_000);
      const secret = deps.memberToken ?? "";
      if (!secret || typeof memberToken !== "string" || !equalHex(tag("m", secret), tag("m", memberToken))) return refuse(401, "unauthorized");
      return { member: store.hasKeyHash(keyHashOf(hexField(body, "pubkey", 32))) };
    },
  };

  let lastSweep = 0;

  async function handle(request: AccountRequest): Promise<AccountResponse> {
    const now = deps.now();
    if (now - lastSweep > 600_000) {
      lastSweep = now;
      store.sweep(now);
    }
    const route = Object.hasOwn(routes, request.route) ? routes[request.route] : undefined;
    if (!route) return { status: 404, body: { error: "not_found" } };
    try {
      return { status: 200, body: await route(request) };
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, body: { error: error.code } };
      throw error;
    }
  }

  return { handle, routes: Object.keys(routes) };
}

/** An in-memory store: the suite's, and a reference for what the SQLite one must do. */
export function memoryStore(): AccountStore & { dump(): string } {
  const accounts = new Map<string, AccountRow>();
  const codes = new Map<string, CodeRow>();
  const tokens = new Map<string, TokenRow>();
  const keys = new Map<string, number>();
  const codeKey = (emailHash: string, purpose: CodePurpose) => `${purpose}:${emailHash}`;
  return {
    getAccount: (emailHash) => accounts.get(emailHash) ?? null,
    putAccount: (row) => void accounts.set(row.emailHash, { ...row }),
    deleteAccount: (emailHash) => void accounts.delete(emailHash),
    getCode: (emailHash, purpose) => codes.get(codeKey(emailHash, purpose)) ?? null,
    putCode: (row) => void codes.set(codeKey(row.emailHash, row.purpose), { ...row }),
    deleteCode: (emailHash, purpose) => void codes.delete(codeKey(emailHash, purpose)),
    getToken: (tokenHash) => tokens.get(tokenHash) ?? null,
    putToken: (row) => void tokens.set(row.tokenHash, { ...row }),
    deleteToken: (tokenHash) => void tokens.delete(tokenHash),
    deleteTokensFor: (emailHash) => {
      for (const [hash, row] of tokens) if (row.emailHash === emailHash) tokens.delete(hash);
    },
    hasKeyHash: (keyHash) => keys.has(keyHash),
    putKeyHash: (keyHash, day) => void keys.set(keyHash, day),
    deleteKeyHash: (keyHash) => void keys.delete(keyHash),
    sweep: (now) => {
      for (const [key, row] of codes) if (row.expiresAt <= now) codes.delete(key);
      for (const [hash, row] of tokens) if (row.expiresAt <= now) tokens.delete(hash);
    },
    /** Everything at rest, as text: what a thief of the database would hold. */
    dump: () => JSON.stringify({ accounts: [...accounts.values()], codes: [...codes.values()], tokens: [...tokens.values()], keys: [...keys] }),
  };
}
