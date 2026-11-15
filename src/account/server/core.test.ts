import net from "node:net";

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { AccountError, createAccountClient, type EventTemplate } from "../client";
import { createAccountServer, memoryStore, type AccountStore, type Mail } from "./core";
import { buildMessage, smtpMailer } from "./mail";
import { sqliteStore } from "./sqliteStore";

const URL_ = "https://accounts.example";
const EMAIL = "Tibs@Example.com";
const PASSWORD = "a long enough passphrase";

function world(store: AccountStore = memoryStore(), memberToken = "relay-secret") {
  const outbox: Mail[] = [];
  let now = Date.parse("2026-11-14T12:00:00Z");
  let ip = "203.0.113.7";
  const server = createAccountServer({
    store,
    pepper: new Uint8Array(32).fill(9),
    sendMail: async (mail) => void outbox.push(mail),
    now: () => now,
    publicUrl: URL_,
    appName: "Wizardry",
    memberToken,
  });
  const post = async (route: string, body: unknown, headers: Record<string, string> = {}) => {
    const answer = await server.handle({
      route,
      body,
      ip,
      bearer: headers.authorization?.replace("Bearer ", ""),
      memberToken: headers["x-member-token"],
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const client = createAccountClient({
    baseUrl: URL_,
    nowSecs: () => Math.floor(now / 1000),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      post(String(input).replace(`${URL_}/v1/`, ""), JSON.parse(String(init?.body)), init?.headers as Record<string, string>)) as typeof fetch,
  });
  const lastCode = () => outbox.at(-1)!.subject.match(/^(\d{6}) /)![1];
  return {
    server, client, outbox, post, lastCode, store,
    advance: (ms: number) => { now += ms; },
    fromIp: (next: string) => { ip = next; },
    async account() {
      await client.signUp(EMAIL, PASSWORD);
      return client.confirmSignUp(EMAIL, PASSWORD, lastCode());
    },
  };
}

const signer = (sk: Uint8Array) => async (template: EventTemplate) => finalizeEvent(template, sk);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccountError) return error.code;
    throw error;
  }
  return "resolved";
}

describe("account server", () => {
  it("signs up with an emailed code, stores a key, and gives it back on another device", async () => {
    const w = world();
    const session = await w.account();
    expect(session.contents).toBeNull();
    const sk = generateSecretKey();
    const recoveryCode = await w.client.storeKey(session, { sk: bytesToHex(sk) });
    expect(recoveryCode).toMatch(/^.{5}-.{5}-.{5}-.{5}$/);

    const elsewhere = await w.client.signIn("tibs@example.com", PASSWORD);
    expect(elsewhere.contents).toEqual({ sk: bytesToHex(sk) });
    expect(elsewhere.hasRecovery).toBe(true);
    expect(await codeOf(w.client.signIn(EMAIL, "the wrong passphrase"))).toBe("invalid_credentials");
  });

  it("keeps nothing at rest that names the person, the password or the key", async () => {
    const store = memoryStore();
    const w = world(store);
    const session = await w.account();
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    await w.client.storeKey(session, { sk: bytesToHex(sk) });
    await w.client.linkKey(session.token, signer(sk));

    const atRest = store.dump().toLowerCase();
    expect(atRest).not.toContain("tibs");
    expect(atRest).not.toContain("example.com");
    expect(atRest).not.toContain(PASSWORD);
    expect(atRest).not.toContain(bytesToHex(sk));
    expect(atRest).not.toContain(pubkey);
    expect(atRest).not.toContain(session.authKey);
    expect(atRest).not.toContain(session.token);
    // The key table has a hash and a day: no column ties it to an account.
    const { keys, accounts } = JSON.parse(store.dump()) as { keys: [string, number][]; accounts: { emailHash: string }[] };
    expect(keys).toHaveLength(1);
    expect(keys[0][0]).not.toContain(accounts[0].emailHash);
    expect(Object.keys(accounts[0])).not.toContain("pubkey");
  });

  it("answers the same for an address with an account and one without", async () => {
    const w = world();
    await w.account();
    const known = await (await w.post("prelogin", { email: EMAIL })).json();
    const unknown = await (await w.post("prelogin", { email: "nobody@example.com" })).json();
    const again = await (await w.post("prelogin", { email: "nobody@example.com" })).json();
    expect(Object.keys(unknown)).toEqual(Object.keys(known));
    expect(unknown.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(again.salt).toBe(unknown.salt);

    // Signing up again with a taken address looks like success, and the owner is told by mail.
    const before = w.outbox.length;
    await w.client.signUp(EMAIL, "someone else's guess");
    expect(w.outbox.length).toBe(before + 1);
    expect(w.outbox.at(-1)!.subject).toContain("already have");
    expect((await w.client.signIn(EMAIL, PASSWORD)).token).toMatch(/^[0-9a-f]{64}$/);

    // Recovery for an unknown address sends nothing and says nothing.
    const sent = w.outbox.length;
    await w.client.startRecovery("nobody@example.com");
    expect(w.outbox.length).toBe(sent);
  });

  it("gives a code five tries and fifteen minutes", async () => {
    const w = world();
    await w.client.signUp(EMAIL, PASSWORD);
    const code = w.lastCode();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1) expect(await codeOf(w.client.confirmSignUp(EMAIL, PASSWORD, wrong))).toBe("invalid_code");
    expect(await codeOf(w.client.confirmSignUp(EMAIL, PASSWORD, code))).toBe("invalid_code");
    expect(await codeOf(w.client.signIn(EMAIL, PASSWORD))).toBe("unverified");

    w.advance(3_600_000);
    await w.client.signUp(EMAIL, PASSWORD);
    const fresh = w.lastCode();
    w.advance(16 * 60_000);
    expect(await codeOf(w.client.confirmSignUp(EMAIL, PASSWORD, fresh))).toBe("invalid_code");
  });

  it("needs the password as well as the code to confirm an address", async () => {
    const w = world();
    await w.client.signUp(EMAIL, PASSWORD);
    expect(await codeOf(w.client.confirmSignUp(EMAIL, "not the password", w.lastCode()))).toBe("invalid_code");
  });

  it("recovers the key with the emailed code and the recovery code, and retires the old ones", async () => {
    const w = world();
    const session = await w.account();
    const sk = bytesToHex(generateSecretKey());
    const recoveryCode = await w.client.storeKey(session, { sk });

    await w.client.startRecovery(EMAIL);
    const mailCode = w.lastCode();
    expect(await codeOf(w.client.recover(EMAIL, mailCode, "AAAAA-AAAAA-AAAAA-AAAAA", "new passphrase"))).toBe("invalid_code");
    const recovered = await w.client.recover(EMAIL, mailCode, recoveryCode.toLowerCase(), "a brand new passphrase");
    expect(recovered.session.contents).toEqual({ sk });
    expect(recovered.recoveryCode).not.toBe(recoveryCode);

    expect(await codeOf(w.client.signIn(EMAIL, PASSWORD))).toBe("invalid_credentials");
    expect((await w.client.signIn(EMAIL, "a brand new passphrase")).contents).toEqual({ sk });
    // The session from before the reset is dead.
    expect(await codeOf(w.client.forgetKey(session.token))).toBe("unauthorized");
    // The old recovery code no longer opens anything.
    w.advance(3_600_000);
    await w.client.startRecovery(EMAIL);
    expect(await codeOf(w.client.recover(EMAIL, w.lastCode(), recoveryCode, "third passphrase"))).toBe("invalid_code");
  });

  it("with no recovery code, the emailed code keeps the account and loses the key", async () => {
    const w = world();
    const session = await w.account();
    await w.client.storeKey(session, { sk: bytesToHex(generateSecretKey()) });
    await w.client.startRecovery(EMAIL);
    const restarted = await w.client.startOver(EMAIL, w.lastCode(), "starting again");
    expect(restarted.contents).toBeNull();
    expect(restarted.hasRecovery).toBe(false);
    expect((await w.client.signIn(EMAIL, "starting again")).vault).toBeNull();
  });

  it("re-locks the vault when the password changes", async () => {
    const w = world();
    const session = await w.account();
    const sk = bytesToHex(generateSecretKey());
    await w.client.storeKey(session, { sk });
    const opened = await w.client.signIn(EMAIL, PASSWORD);
    const changed = await w.client.changePassword(opened, "second passphrase");
    expect(changed.contents).toEqual({ sk });
    expect((await w.client.signIn(EMAIL, "second passphrase")).contents).toEqual({ sk });
    expect(await codeOf(w.client.signIn(EMAIL, PASSWORD))).toBe("invalid_credentials");
  });

  it("links a key only on its own signature, for this server and this minute", async () => {
    const w = world();
    const session = await w.account();
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const member = async (key: string, token = "relay-secret") =>
      (await w.post("member/check", { pubkey: key }, { "x-member-token": token })).json();

    expect(await member(pubkey)).toEqual({ member: false });
    // A proof for another server, a stale one and a forged one are all refused.
    const forged = async (template: EventTemplate) => ({ ...finalizeEvent(template, sk), pubkey: getPublicKey(generateSecretKey()) });
    expect(await codeOf(w.client.linkKey(session.token, forged))).toBe("invalid_proof");
    const elsewhere = async (template: EventTemplate) => finalizeEvent({ ...template, tags: [["u", "https://evil.example/v1/key/link"], ["method", "POST"]] }, sk);
    expect(await codeOf(w.client.linkKey(session.token, elsewhere))).toBe("invalid_proof");
    const stale = async (template: EventTemplate) => finalizeEvent({ ...template, created_at: template.created_at - 600 }, sk);
    expect(await codeOf(w.client.linkKey(session.token, stale))).toBe("invalid_proof");
    expect(await member(pubkey)).toEqual({ member: false });

    await w.client.linkKey(session.token, signer(sk));
    expect(await member(pubkey)).toEqual({ member: true });
    expect(await member(getPublicKey(generateSecretKey()))).toEqual({ member: false });
    // The check is for the relay that holds the secret, not for anyone who asks.
    expect((await w.post("member/check", { pubkey }, { "x-member-token": "guess" })).status).toBe(401);
    expect((await w.post("member/check", { pubkey })).status).toBe(401);

    await w.client.linkKey(session.token, signer(sk), true);
    expect(await member(pubkey)).toEqual({ member: false });
  });

  it("slows a guesser down, per address and per caller", async () => {
    const w = world();
    await w.account();
    let last = "";
    for (let i = 0; i < 11; i += 1) {
      w.fromIp(`198.51.100.${i}`);
      last = (await (await w.post("login", { email: EMAIL, authKey: "00".repeat(32) })).json()).error;
    }
    expect(last).toBe("rate_limited");
    w.advance(11 * 60_000);
    expect((await w.client.signIn(EMAIL, PASSWORD)).token).toBeTruthy();
  });

  it("deletes an account on the password, and refuses malformed input everywhere", async () => {
    const w = world();
    const session = await w.account();
    expect((await w.post("account/delete", { authKey: "11".repeat(32) }, { authorization: `Bearer ${session.token}` })).status).toBe(401);
    await w.client.deleteAccount(session);
    expect(await codeOf(w.client.signIn(EMAIL, PASSWORD))).toBe("invalid_credentials");

    expect((await w.post("login", { email: "not an address", authKey: "00".repeat(32) })).status).toBe(400);
    expect((await w.post("login", { email: EMAIL, authKey: "short" })).status).toBe(400);
    expect((await w.post("vault/put", { vault: "zz" })).status).toBe(401);
    expect((await w.post("constructor", {})).status).toBe(404);
    expect((await w.post("nope", {})).status).toBe(404);
  });

  it("behaves the same on SQLite as in memory", async () => {
    const store = sqliteStore(":memory:");
    const w = world(store);
    const session = await w.account();
    const sk = generateSecretKey();
    const recoveryCode = await w.client.storeKey(session, { sk: bytesToHex(sk) });
    await w.client.linkKey(session.token, signer(sk));
    expect((await w.client.signIn(EMAIL, PASSWORD)).contents).toEqual({ sk: bytesToHex(sk) });
    expect(await (await w.post("member/check", { pubkey: getPublicKey(sk) }, { "x-member-token": "relay-secret" })).json()).toEqual({ member: true });
    await w.client.startRecovery(EMAIL);
    const recovered = await w.client.recover(EMAIL, w.lastCode(), recoveryCode, "after recovery");
    expect(recovered.session.contents).toEqual({ sk: bytesToHex(sk) });
    w.advance(40 * 86_400_000);
    store.sweep(Date.parse("2027-01-01T00:00:00Z"));
    expect(await codeOf(w.client.forgetKey(recovered.session.token))).toBe("unauthorized");
    store.close();
  });
});

describe("account mail", () => {
  it("builds a message whose headers cannot be forged from a subject", () => {
    const message = buildMessage({ to: "a@example.com", subject: "hi\r\nBcc: x@example.com", text: "one\n.two\n" }, "Wizardry <hello@example.com>", new Date(0), "id@example.com");
    expect(message.split("\r\n").filter((line) => line.startsWith("Bcc:"))).toEqual([]);
    expect(message).toContain("Subject: hi Bcc: x@example.com");
    expect(message).toContain("Content-Transfer-Encoding: base64");
  });

  it("speaks SMTP to a submission server and reports a refusal", async () => {
    const received: string[] = [];
    let refuseRcpt = false;
    const fake = net.createServer((socket) => {
      let data = false;
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk) => {
        for (const line of chunk.toString().split("\r\n")) {
          if (!line && !data) continue;
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 queued\r\n");
            } else received.push(line);
            continue;
          }
          received.push(line);
          if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("RCPT") && refuseRcpt) socket.write("550 no such user\r\n");
          else if (line === "DATA") { data = true; socket.write("354 go on\r\n"); }
          else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const { port } = fake.address() as net.AddressInfo;
    const send = smtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "Wizardry <hello@example.com>" });

    await send({ to: "tibs@example.com", subject: "123456 is your Wizardry code", text: "Your code is 123456.\n" });
    expect(received).toContain("MAIL FROM:<hello@example.com>");
    expect(received).toContain("RCPT TO:<tibs@example.com>");
    expect(received.some((line) => line === "Subject: 123456 is your Wizardry code")).toBe(true);

    refuseRcpt = true;
    await expect(send({ to: "gone@example.com", subject: "x", text: "y" })).rejects.toThrow(/refused/);
    expect(() => smtpMailer({ url: "smtp://user:pw@mail.example.com:25", from: "a@example.com" })).toThrow(/without TLS/);
    await new Promise((resolve) => fake.close(resolve));
  });
});
