import { describe, expect, it } from "vitest";
import { bech32 } from "@scure/base";
import { getPublicKey, nip19 } from "nostr-tools";
import { decrypt as ntDecrypt, encrypt as ntEncrypt } from "nostr-tools/nip49";

import {
  decryptNcryptsecToNsec,
  encryptNsecToNcryptsec,
  isNcryptsec,
  NcryptsecError,
  readNcryptsec,
} from "@/lib/nip49";

/**
 * The vector from NIP-49 itself: decrypting this with password "nostr" must
 * yield the published secret. It is the only thing that proves salt offsets,
 * the AAD byte and the bech32 framing are all right.
 */
const SPEC_NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
const SPEC_HEX = "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683";

const secretKey = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
);
const nsec = nip19.nsecEncode(secretKey);

describe("nip49", () => {
  it("decrypts the NIP-49 test vector", async () => {
    const decrypted = await decryptNcryptsecToNsec(SPEC_NCRYPTSEC, "nostr");
    expect(decrypted).toBe(nip19.nsecEncode(Uint8Array.from(Buffer.from(SPEC_HEX, "hex"))));
  });

  it("round-trips an nsec through a password", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "correct horse battery staple");
    expect(isNcryptsec(ncryptsec)).toBe(true);
    expect(await decryptNcryptsecToNsec(ncryptsec, "correct horse battery staple")).toBe(nsec);
  });

  it("produces the 91-byte payload the spec describes", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "pw");
    const header = readNcryptsec(ncryptsec);
    expect(header).not.toBeNull();
    // 91 bytes → 146 bech32 words → "ncryptsec1" + 146 + 6 checksum chars.
    expect(ncryptsec).toHaveLength("ncryptsec".length + 1 + 146 + 6);
    expect(header?.logN).toBe(16);
  });

  it("rejects a wrong password as a wrong password", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "right");
    await expect(decryptNcryptsecToNsec(ncryptsec, "wrong")).rejects.toBeInstanceOf(NcryptsecError);
    await expect(decryptNcryptsecToNsec(ncryptsec, "wrong")).rejects.toThrow(/wrong password/i);
  });

  it("rejects a tampered ciphertext instead of returning a garbage key", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "pw");
    // Flip a character in the payload body, keeping the checksum valid is not
    // required — either way it must not decrypt.
    const tampered = `${ncryptsec.slice(0, 40)}${ncryptsec[40] === "q" ? "p" : "q"}${ncryptsec.slice(41)}`;
    await expect(decryptNcryptsecToNsec(tampered, "pw")).rejects.toBeInstanceOf(NcryptsecError);
  });

  it("normalizes the password to NFKC, as the spec requires", async () => {
    const decomposed = "\u212B\u2126\u1E9B\u0323";
    const composed = "\u00C5\u03A9\u1E69";
    const ncryptsec = await encryptNsecToNcryptsec(nsec, decomposed);
    expect(await decryptNcryptsecToNsec(ncryptsec, composed)).toBe(nsec);
  });

  it("carries the key-security flag through encryption and back", async () => {
    for (const keySecurity of ["insecure", "secure", "unknown"] as const) {
      const ncryptsec = await encryptNsecToNcryptsec(nsec, "pw", { keySecurity });
      expect(readNcryptsec(ncryptsec)?.keySecurity).toBe(keySecurity);
      expect(await decryptNcryptsecToNsec(ncryptsec, "pw")).toBe(nsec);
    }
  });

  it("refuses to bind a payload whose key-security flag was flipped", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "pw", { keySecurity: "insecure" });
    const decoded = bech32Body(ncryptsec);
    decoded[2 + 16 + 24] = 0x01;
    const forged = encodeBody(decoded);
    await expect(decryptNcryptsecToNsec(forged, "pw")).rejects.toThrow(/wrong password/i);
  });

  it("is byte-compatible with nostr-tools in both directions", async () => {
    const mine = await encryptNsecToNcryptsec(nsec, "shared password", { logN: 16, keySecurity: "secure" });
    expect(Buffer.from(ntDecrypt(mine, "shared password")).toString("hex")).toBe(
      Buffer.from(secretKey).toString("hex"),
    );

    const theirs = ntEncrypt(secretKey, "shared password", 16, 0x01);
    expect(await decryptNcryptsecToNsec(theirs, "shared password")).toBe(nsec);
    expect(readNcryptsec(theirs)?.keySecurity).toBe("secure");
  });

  it("round-trips a derived public key, which is what the app logs in with", async () => {
    const ncryptsec = await encryptNsecToNcryptsec(nsec, "pw");
    const decrypted = await decryptNcryptsecToNsec(ncryptsec, "pw");
    const decoded = nip19.decode(decrypted);
    expect(decoded.type).toBe("nsec");
    expect(nip19.npubEncode(getPublicKey(decoded.data as Uint8Array))).toBe(
      nip19.npubEncode(getPublicKey(secretKey)),
    );
  });

  it("rejects anything that is not a usable ncryptsec", () => {
    for (const value of [
      "",
      "nsec1qqqq",
      "npub1abc",
      "ncryptsec1",
      "hello world",
      // A valid key but with the version byte moved to 0x03.
      (() => {
        const decoded = bech32Body(SPEC_NCRYPTSEC);
        decoded[0] = 0x03;
        return encodeBody(decoded);
      })(),
      // And one whose scrypt cost is beyond what a tab can run.
      (() => {
        const decoded = bech32Body(SPEC_NCRYPTSEC);
        decoded[1] = 30;
        return encodeBody(decoded);
      })(),
    ]) {
      expect(isNcryptsec(value), value).toBe(false);
      expect(readNcryptsec(value), value).toBeNull();
    }
  });

  it("reports an unreadable payload as such rather than as a wrong password", async () => {
    await expect(decryptNcryptsecToNsec("ncryptsec1nonsense", "pw")).rejects.toThrow(
      /valid encrypted key/i,
    );
  });

  it("refuses a value that is not a secret key", async () => {
    await expect(encryptNsecToNcryptsec(nip19.npubEncode(getPublicKey(secretKey)), "pw")).rejects.toThrow(
      /not a secret key/i,
    );
  });
});

/** Decode to the 91 payload bytes, for tests that forge one field. */
function bech32Body(ncryptsec: string): Uint8Array {
  const { words } = bech32.decode(ncryptsec, 1024);
  return Uint8Array.from(bech32.fromWords(words));
}

function encodeBody(payload: Uint8Array): string {
  return bech32.encode("ncryptsec", bech32.toWords(payload), 1024);
}
