/**
 * {@link AccountStore} over `node:sqlite`. Five small tables; note that
 * `key_hashes` has no account column, on purpose (see core.ts).
 */
import { DatabaseSync } from "node:sqlite";

import type { AccountRow, AccountStore, CodePurpose, CodeRow, TokenKind, TokenRow } from "./core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  email_hash TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  verifier_salt TEXT NOT NULL,
  verifier TEXT NOT NULL,
  verified INTEGER NOT NULL,
  vault TEXT,
  recovery_salt TEXT,
  recovery_verifier TEXT,
  recovery_vault TEXT,
  key_linked INTEGER NOT NULL,
  created_day INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS codes (
  email_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (email_hash, purpose)
) STRICT;
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tokens_by_account ON tokens (email_hash);
CREATE TABLE IF NOT EXISTS key_hashes (
  key_hash TEXT PRIMARY KEY,
  day INTEGER NOT NULL
) STRICT;
`;

type Row = Record<string, string | number | null>;

export function sqliteStore(path: string): AccountStore & { close(): void } {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  const one = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).get(...args) as Row | undefined;
  const run = (sql: string, ...args: (string | number | null)[]) => void db.prepare(sql).run(...args);
  const text = (value: string | number | null) => (value === null ? null : String(value));

  return {
    getAccount(emailHash) {
      const row = one("SELECT * FROM accounts WHERE email_hash = ?", emailHash);
      if (!row) return null;
      const account: AccountRow = {
        emailHash: String(row.email_hash),
        salt: String(row.salt),
        verifierSalt: String(row.verifier_salt),
        verifier: String(row.verifier),
        verified: row.verified === 1,
        vault: text(row.vault),
        recoverySalt: text(row.recovery_salt),
        recoveryVerifier: text(row.recovery_verifier),
        recoveryVault: text(row.recovery_vault),
        keyLinked: row.key_linked === 1,
        createdDay: Number(row.created_day),
      };
      return account;
    },
    putAccount(row) {
      run(
        `INSERT OR REPLACE INTO accounts
         (email_hash, salt, verifier_salt, verifier, verified, vault, recovery_salt, recovery_verifier, recovery_vault, key_linked, created_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.emailHash, row.salt, row.verifierSalt, row.verifier, row.verified ? 1 : 0, row.vault,
        row.recoverySalt, row.recoveryVerifier, row.recoveryVault, row.keyLinked ? 1 : 0, row.createdDay,
      );
    },
    deleteAccount: (emailHash) => run("DELETE FROM accounts WHERE email_hash = ?", emailHash),
    getCode(emailHash, purpose) {
      const row = one("SELECT * FROM codes WHERE email_hash = ? AND purpose = ?", emailHash, purpose);
      if (!row) return null;
      const code: CodeRow = {
        emailHash, purpose: row.purpose as CodePurpose, codeHash: String(row.code_hash),
        expiresAt: Number(row.expires_at), attempts: Number(row.attempts),
      };
      return code;
    },
    putCode: (row) => run(
      "INSERT OR REPLACE INTO codes (email_hash, purpose, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, ?)",
      row.emailHash, row.purpose, row.codeHash, row.expiresAt, row.attempts,
    ),
    deleteCode: (emailHash, purpose) => run("DELETE FROM codes WHERE email_hash = ? AND purpose = ?", emailHash, purpose),
    getToken(tokenHash) {
      const row = one("SELECT * FROM tokens WHERE token_hash = ?", tokenHash);
      if (!row) return null;
      const token: TokenRow = { tokenHash, kind: row.kind as TokenKind, emailHash: String(row.email_hash), expiresAt: Number(row.expires_at) };
      return token;
    },
    putToken: (row) => run(
      "INSERT OR REPLACE INTO tokens (token_hash, kind, email_hash, expires_at) VALUES (?, ?, ?, ?)",
      row.tokenHash, row.kind, row.emailHash, row.expiresAt,
    ),
    deleteToken: (tokenHash) => run("DELETE FROM tokens WHERE token_hash = ?", tokenHash),
    deleteTokensFor: (emailHash) => run("DELETE FROM tokens WHERE email_hash = ?", emailHash),
    hasKeyHash: (keyHash) => one("SELECT 1 AS found FROM key_hashes WHERE key_hash = ?", keyHash) !== undefined,
    putKeyHash: (keyHash, day) => run("INSERT OR IGNORE INTO key_hashes (key_hash, day) VALUES (?, ?)", keyHash, day),
    deleteKeyHash: (keyHash) => run("DELETE FROM key_hashes WHERE key_hash = ?", keyHash),
    sweep(now) {
      run("DELETE FROM codes WHERE expires_at <= ?", now);
      run("DELETE FROM tokens WHERE expires_at <= ?", now);
    },
    close: () => db.close(),
  };
}
