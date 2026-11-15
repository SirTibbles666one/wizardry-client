import { describe, expect, it } from "vitest";

import { createRecovery, deriveKeys, deriveRecoveryKeys, newRecoveryCode, newSalt, normalizeRecoveryCode, openVault, sealVault } from "./crypto";
import { VAULT_BYTES, normalizeEmail } from "./protocol";

const SK = "7f".repeat(32);

describe("account crypto", () => {
  it("derives the same keys for the same password and salt, and unrelated ones otherwise", async () => {
    const salt = newSalt();
    const a = await deriveKeys("correct horse battery staple", salt);
    const b = await deriveKeys("correct horse battery staple", salt);
    const c = await deriveKeys("correct horse battery stapler", salt);
    const d = await deriveKeys("correct horse battery staple", newSalt());
    expect(a.authKey).toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
    expect(a.authKey).not.toBe(d.authKey);
    // What the server is sent must not be the key that opens the vault.
    expect(a.authKey).not.toBe(Buffer.from(a.vaultKey).toString("hex"));
  });

  it("treats composed and decomposed spellings of a password as one", async () => {
    const salt = newSalt();
    expect((await deriveKeys("café", salt)).authKey).toBe((await deriveKeys("café", salt)).authKey);
  });

  it("refuses a cost the server has turned down", async () => {
    await expect(deriveKeys("pw", newSalt(), { n: 1024, r: 8, p: 1 })).rejects.toThrow("bad kdf");
  });

  it("seals to a fixed length and opens only with the right key", async () => {
    const { vaultKey } = await deriveKeys("pw one", newSalt());
    const other = await deriveKeys("pw two", newSalt());
    const vault = sealVault(vaultKey, { sk: SK });
    expect(vault.length).toBe(VAULT_BYTES * 2);
    expect(vault).not.toContain(SK);
    expect(openVault(vaultKey, vault)).toEqual({ sk: SK });
    expect(() => openVault(other.vaultKey, vault)).toThrow();
    // Two seals of one key differ, so a vault says nothing by being equal to another.
    expect(sealVault(vaultKey, { sk: SK })).not.toBe(vault);
  });

  it("rejects a vault with one flipped bit", async () => {
    const { vaultKey } = await deriveKeys("pw", newSalt());
    const vault = sealVault(vaultKey, { sk: SK });
    const flipped = vault.slice(0, 80) + (vault[80] === "0" ? "1" : "0") + vault.slice(81);
    expect(() => openVault(vaultKey, flipped)).toThrow();
  });

  it("makes recovery codes that survive being retyped", () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(normalizeRecoveryCode("OIL00-00000-00000-00000")).toBe("01100-00000-00000-00000");
    expect(normalizeRecoveryCode("too short")).toBeNull();
    expect(newRecoveryCode()).not.toBe(code);
  });

  it("opens the recovery copy with the code and nothing else", async () => {
    const { code, bundle } = await createRecovery({ sk: SK });
    const right = await deriveRecoveryKeys(code, bundle.salt);
    expect(right.auth).toBe(bundle.auth);
    expect(openVault(right.vaultKey, bundle.vault)).toEqual({ sk: SK });
    const wrong = await deriveRecoveryKeys(newRecoveryCode(), bundle.salt);
    expect(() => openVault(wrong.vaultKey, bundle.vault)).toThrow();
  });

  it("gives an address one spelling", () => {
    expect(normalizeEmail("  Tibs@Example.COM ")).toBe("tibs@example.com");
    expect(normalizeEmail("no-at-sign")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("two words@example.com")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});
