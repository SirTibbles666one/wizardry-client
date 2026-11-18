import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These run in the `node` project on purpose: Node has real WebCrypto
 * (`crypto.subtle`) and `fake-indexeddb` gives a real structured-clone store,
 * so a `CryptoKey` is cloned the way a browser clones it — the mechanism under
 * test is the mechanism the app uses.
 */

const PLAINTEXT = JSON.stringify([{ type: "nsec", pubkey: "ab".repeat(32), nsec: "nsec1secret" }]);

/** A fresh module instance per test: the key is cached for the session. */
const load = async () => {
  vi.resetModules();
  return await import("@/lib/deviceSeal");
};

beforeEach(() => {
  // Each test is a fresh browser profile.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("deviceSeal", () => {
  it("seals the login list so the nsec is not in the stored bytes", async () => {
    const { sealText } = await load();
    const sealed = await sealText(PLAINTEXT);

    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain("nsec1secret");
    expect(JSON.parse(sealed!)).toMatchObject({ v: 1, enc: "device" });
  });

  it("round-trips through the envelope", async () => {
    const { sealText, unsealText } = await load();
    const sealed = await sealText(PLAINTEXT);

    await expect(unsealText(sealed!)).resolves.toBe(PLAINTEXT);
  });

  it("uses a new IV each time, so two seals of one value differ", async () => {
    const { sealText } = await load();
    const first = await sealText(PLAINTEXT);
    const second = await sealText(PLAINTEXT);

    expect(first).not.toBe(second);
    expect(JSON.parse(first!).data).not.toBe(JSON.parse(second!).data);
  });

  it("keeps the key non-extractable, so script cannot lift it out", async () => {
    const { sealText } = await load();
    await sealText(PLAINTEXT);

    const key = await new Promise<CryptoKey | null>((resolve, reject) => {
      const open = indexedDB.open("wizardry-seal", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction("keys", "readonly").objectStore("keys").get("login-seal-v1");
        request.onsuccess = () => resolve((request.result as CryptoKey) ?? null);
        request.onerror = () => reject(request.error);
      };
    });

    expect(key).not.toBeNull();
    expect(key!.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key!)).rejects.toBeTruthy();
  });

  it("refuses a tampered payload instead of returning garbage", async () => {
    const { sealText, unsealText } = await load();
    const sealed = await sealText(PLAINTEXT);
    const envelope = JSON.parse(sealed!);

    // Flip a byte in the ciphertext; GCM must reject it.
    const bytes = atob(envelope.data);
    const flipped = String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 0xff);
    envelope.data = btoa(bytes.slice(0, -1) + flipped);

    await expect(unsealText(JSON.stringify(envelope))).resolves.toBeNull();
  });

  it("cannot open a blob written by a different profile's key", async () => {
    const first = await load();
    const sealed = await first.sealText(PLAINTEXT);

    // New profile: new IndexedDB, so no key that can open it.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const second = await load();
    await expect(second.unsealText(sealed!)).resolves.toBeNull();
  });

  it("does not mint a key just to read, so a locked profile stays locked", async () => {
    const { unsealText } = await load();
    const fake = JSON.stringify({ v: 1, enc: "device", data: btoa("0123456789ab-and-more") });

    await expect(unsealText(fake)).resolves.toBeNull();
  });

  it("ignores anything that is not its own envelope", async () => {
    const { unsealText, parseDeviceEnvelope } = await load();

    for (const value of ["[]", PLAINTEXT, '{"v":1,"enc":"safeStorage","data":"x"}', "not json"]) {
      expect(parseDeviceEnvelope(value)).toBeNull();
      await expect(unsealText(value)).resolves.toBeNull();
    }
  });

  it("reports unavailability instead of throwing when there is no SubtleCrypto", async () => {
    const original = globalThis.crypto;
    // @ts-expect-error — a browser without WebCrypto (or an insecure context).
    delete globalThis.crypto;

    const { sealText, unsealText } = await load();
    await expect(sealText(PLAINTEXT)).resolves.toBeNull();
    await expect(unsealText('{"v":1,"enc":"device","data":"AAAA"}')).resolves.toBeNull();

    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
  });
});
