/**
 * The way past the gate for someone who already has a key.
 *
 * Without it the account gate is the only front door, so shipping accounts would lock out every
 * key-only user on the day it goes live.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

const session = async () => {
  const mod = await import("./session");
  mod._resetAccountSessionForTests();
  return mod;
};

describe("useKeyInstead", () => {
  it("is off until the device asks for it", async () => {
    const s = await session();
    expect(s.useKeyInstead()).toBe(false);
  });

  it("stays on once chosen, so the gate does not come back on the next visit", async () => {
    const s = await session();
    s.skipAccountGate();
    expect(s.useKeyInstead()).toBe(true);
  });

  it("is cleared by an account sign-in, because that answers the question", async () => {
    const s = await session();
    s.skipAccountGate();
    s.setAccountSession({ token: "a".repeat(64) } as never);
    expect(s.useKeyInstead()).toBe(false);
  });

  it("treats storage that throws as no choice rather than an error", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    const s = await session();
    expect(() => s.skipAccountGate()).not.toThrow();
    expect(s.useKeyInstead()).toBe(false);
  });
});
