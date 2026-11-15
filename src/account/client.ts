/**
 * The account server's client: the calls, and the flows built from them. All
 * secrets are derived and sealed here (`crypto.ts`); what crosses the network is
 * what `protocol.ts` says the server may see.
 */
import { config } from "@/lib/env";

import { createRecovery, deriveKeys, deriveRecoveryKeys, newSalt, openVault, sealVault } from "./crypto";
import {
  KEY_PROOF_KIND,
  normalizeEmail,
  type AccountErrorCode,
  type AccountStatus,
  type KdfParams,
  type PreloginResponse,
  type RecoveryBundle,
  type RecoveryOpenResponse,
  type SessionResponse,
  type VaultContents,
} from "./protocol";

/** The account server's origin, or "" when this build has none (accounts off). */
export function accountServerUrl(): string {
  return (config("ACCOUNT_SERVER") ?? "").trim().replace(/\/+$/, "");
}

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, readonly status = 0) {
    super(code);
    this.name = "AccountError";
  }
}

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Signs with the key being linked: the user's signer, whatever kind of login it is. */
export type SignEvent = (template: EventTemplate) => Promise<unknown>;

export interface AccountClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Seconds; defaults to the device clock. Pass the relay-corrected one where there is one. */
  nowSecs?: () => number;
}

export interface OpenedSession extends SessionResponse {
  /** The decrypted key, or null when the account has none stored. */
  contents: VaultContents | null;
  /** Kept in memory for this sign-in only, so a key can be stored without asking for the password again. */
  vaultKey: Uint8Array;
  authKey: string;
}

export function createAccountClient(options: AccountClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? accountServerUrl()).replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const nowSecs = options.nowSecs ?? (() => Math.floor(Date.now() / 1000));

  async function call<T>(route: string, body: unknown, token?: string): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/v1/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AccountError("network");
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // A proxy's HTML error page, say: fall through to the status.
    }
    if (!response.ok) {
      const code = (parsed as { error?: AccountErrorCode } | null)?.error;
      throw new AccountError(code ?? (response.status === 429 ? "rate_limited" : "network"), response.status);
    }
    return parsed as T;
  }

  function mustEmail(input: string): string {
    const email = normalizeEmail(input);
    if (!email) throw new AccountError("bad_request");
    return email;
  }

  async function keysFor(email: string, password: string): Promise<{ authKey: string; vaultKey: Uint8Array; kdf: KdfParams }> {
    const { salt, kdf } = await call<PreloginResponse>("prelogin", { email });
    return { ...(await deriveKeys(password, salt, kdf)), kdf };
  }

  function open(session: SessionResponse, vaultKey: Uint8Array, authKey: string): OpenedSession {
    return { ...session, vaultKey, authKey, contents: session.vault ? openVault(vaultKey, session.vault) : null };
  }

  return {
    /** Step one of sign-up: the server mails a six-digit code. Always resolves the same way for a taken address. */
    async signUp(emailInput: string, password: string): Promise<void> {
      const email = mustEmail(emailInput);
      const salt = newSalt();
      const { authKey } = await deriveKeys(password, salt);
      await call("signup", { email, salt, authKey });
    },

    /** Step two: the emailed code, with the password again so the code alone is worth nothing. */
    async confirmSignUp(emailInput: string, password: string, code: string): Promise<OpenedSession> {
      const email = mustEmail(emailInput);
      const { authKey, vaultKey } = await keysFor(email, password);
      return open(await call<SessionResponse>("verify", { email, authKey, code }), vaultKey, authKey);
    },

    async signIn(emailInput: string, password: string): Promise<OpenedSession> {
      const email = mustEmail(emailInput);
      const { authKey, vaultKey } = await keysFor(email, password);
      return open(await call<SessionResponse>("login", { email, authKey }), vaultKey, authKey);
    },

    /** What the signed-in account holds: a stored key, a recovery copy, a linked key. */
    async status(token: string): Promise<AccountStatus> {
      return call<AccountStatus>("session/status", {}, token);
    },

    /**
     * Reopen the account with the password alone, for someone already signed in:
     * the vault key lives in memory only, so a settings change after a reload
     * has to ask for the password again. No address is needed or sent.
     */
    async unlock(token: string, password: string): Promise<OpenedSession> {
      const { salt, kdf } = await call<PreloginResponse>("session/salt", {}, token);
      const { authKey, vaultKey } = await deriveKeys(password, salt, kdf);
      const answer = await call<Omit<SessionResponse, "token">>("session/unlock", { authKey }, token);
      return open({ ...answer, token }, vaultKey, authKey);
    },

    async signOut(token: string): Promise<void> {
      await call("logout", {}, token);
    },

    /**
     * Lock a Nostr secret key into the account. Returns the recovery code, which
     * exists nowhere else: show it once and make the person save it.
     */
    async storeKey(session: Pick<OpenedSession, "token" | "vaultKey">, contents: VaultContents): Promise<string> {
      const { code, bundle } = await createRecovery(contents);
      await call("vault/put", { vault: sealVault(session.vaultKey, contents), recovery: bundle }, session.token);
      return code;
    },

    /** Remove the stored key and its recovery copy. The key on this device is untouched. */
    async forgetKey(token: string): Promise<void> {
      await call("vault/put", { vault: null }, token);
    },

    /** Tell the server this key is a member's, proving it by signature. The server keeps a hash that names no account. */
    async linkKey(token: string, sign: SignEvent, unlink = false): Promise<void> {
      const route = unlink ? "key/unlink" : "key/link";
      const event = await sign({
        kind: KEY_PROOF_KIND,
        created_at: nowSecs(),
        tags: [["u", `${baseUrl}/v1/${route}`], ["method", "POST"]],
        content: "",
      });
      await call(route, { event }, token);
    },

    async changePassword(session: OpenedSession, newPassword: string): Promise<OpenedSession> {
      const newSalt_ = newSalt();
      const next = await deriveKeys(newPassword, newSalt_);
      const vault = session.contents ? sealVault(next.vaultKey, session.contents) : undefined;
      const answer = await call<SessionResponse>(
        "password/change",
        { authKey: session.authKey, newSalt: newSalt_, newAuthKey: next.authKey, vault },
        session.token,
      );
      return open(answer, next.vaultKey, next.authKey);
    },

    /** Forgot password, step one: mail a code. Resolves the same whether or not the address has an account. */
    async startRecovery(emailInput: string): Promise<void> {
      await call("recover/start", { email: mustEmail(emailInput) });
    },

    /**
     * Forgot password, step two: the emailed code and the saved recovery code
     * open the recovery copy; the key is re-locked under the new password and a
     * NEW recovery code, which is returned to be shown.
     */
    async recover(emailInput: string, mailCode: string, recoveryCode: string, newPassword: string): Promise<{ session: OpenedSession; recoveryCode: string }> {
      const email = mustEmail(emailInput);
      const { salt: recoverySalt, kdf } = await call<PreloginResponse>("recover/salt", { email });
      const old = await deriveRecoveryKeys(recoveryCode, recoverySalt, kdf);
      const opened = await call<RecoveryOpenResponse>("recover/open", { email, code: mailCode, recoveryAuth: old.auth });
      let contents: VaultContents;
      try {
        contents = openVault(old.vaultKey, opened.vault);
      } catch {
        throw new AccountError("invalid_code");
      }
      const salt = newSalt();
      const next = await deriveKeys(newPassword, salt);
      const fresh: { code: string; bundle: RecoveryBundle } = await createRecovery(contents);
      const answer = await call<SessionResponse>("recover/reset", {
        resetToken: opened.resetToken,
        salt,
        authKey: next.authKey,
        vault: sealVault(next.vaultKey, contents),
        recovery: fresh.bundle,
      });
      return { session: open(answer, next.vaultKey, next.authKey), recoveryCode: fresh.code };
    },

    /** Lost both the password and the recovery code: keep the account, lose the stored key. */
    async startOver(emailInput: string, mailCode: string, newPassword: string): Promise<OpenedSession> {
      const email = mustEmail(emailInput);
      const salt = newSalt();
      const next = await deriveKeys(newPassword, salt);
      const answer = await call<SessionResponse>("recover/start-over", { email, code: mailCode, salt, authKey: next.authKey });
      return open(answer, next.vaultKey, next.authKey);
    },

    async deleteAccount(session: Pick<OpenedSession, "token" | "authKey">): Promise<void> {
      await call("account/delete", { authKey: session.authKey }, session.token);
    },
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
