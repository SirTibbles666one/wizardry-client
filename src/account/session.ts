/**
 * The device's account session. Two halves, kept apart on purpose:
 *
 * - On disk (localStorage): the session token and whether a key still has to
 *   be stored. Logout's purge removes it with everything else.
 * - In memory only: the unlocked session, which holds the vault key. It is
 *   never written anywhere, so a reload forgets it and the password is the
 *   only way to get it back.
 */
import { useSyncExternalStore } from "react";

import { accountServerUrl, type OpenedSession } from "./client";

const STORAGE_KEY = "wizardry:account";
const KEY_ONLY_KEY = "wizardry:account-key-only";

interface Persisted {
  token: string;
  /** The account has no stored key and no linked one yet. */
  needsKey: boolean;
}

export interface AccountState extends Persisted {
  /** Present only until the next reload. */
  unlocked: OpenedSession | null;
}

let unlocked: OpenedSession | null = null;
let snapshot: AccountState | null | undefined;
const listeners = new Set<() => void>();

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (typeof parsed.token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.token)) return null;
    return { token: parsed.token, needsKey: parsed.needsKey === true };
  } catch {
    return null;
  }
}

function write(next: Persisted | null): void {
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused (private mode): the session lasts until the tab closes.
  }
  snapshot = next ? { ...next, unlocked } : null;
  for (const listener of listeners) listener();
}

/** True when this build has an account server, so an email and password are required. */
export function accountsEnabled(): boolean {
  return accountServerUrl() !== "";
}

export function getAccountState(): AccountState | null {
  if (snapshot === undefined) {
    const persisted = readPersisted();
    snapshot = persisted ? { ...persisted, unlocked } : null;
  }
  return snapshot;
}

/**
 * Whether the account step is done for now. A session that still owes a key
 * but has forgotten its vault key (a reload mid-setup) is not: the password
 * has to be given again before the key can be locked away.
 */
export function accountReady(state: AccountState | null): boolean {
  return state !== null && (!state.needsKey || state.unlocked !== null);
}

export function setAccountSession(session: OpenedSession): void {
  unlocked = session;
  // Signing in with an account answers the question the key-only choice was avoiding.
  try {
    localStorage.removeItem(KEY_ONLY_KEY);
  } catch {
    // Storage refused: nothing persisted to clear either.
  }
  write({ token: session.token, needsKey: session.vault === null && !session.keyLinked });
}

/**
 * True when this device asked to sign in with a key and keep the account gate out of the way.
 *
 * The gate is otherwise the only front door, and it has no way through for someone who already has
 * a key and no account — which would lock out every existing key-only user the day accounts ship.
 */
export function useKeyInstead(): boolean {
  try {
    return localStorage.getItem(KEY_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember that choice. The next account sign-in clears it again. */
export function skipAccountGate(): void {
  try {
    localStorage.setItem(KEY_ONLY_KEY, "1");
  } catch {
    // Storage refused (private mode): the choice lasts until the tab closes.
  }
}

/** The key is stored or linked: nothing is owed any more. */
export function markAccountKeyDone(): void {
  const current = getAccountState();
  if (current) write({ token: current.token, needsKey: false });
}

export function clearAccountSession(): void {
  unlocked = null;
  write(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useAccountState(): AccountState | null {
  return useSyncExternalStore(subscribe, getAccountState, () => null);
}

export function _resetAccountSessionForTests(): void {
  unlocked = null;
  snapshot = undefined;
}
