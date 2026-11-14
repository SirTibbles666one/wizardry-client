/**
 * Outgoing mail: just enough SMTP to hand one plain-text message to a
 * submission server. `smtps://user:pass@host:465` is TLS from the first byte;
 * `smtp://host:25` is plaintext and meant for a relay on the same machine.
 * Nothing here logs an address or a message.
 */
import net from "node:net";
import tls from "node:tls";

import type { Mail } from "./core";

export interface SmtpOptions {
  /** smtps://user:pass@host:port or smtp://host:port */
  url: string;
  /** The From header and envelope sender, e.g. `Wizardry <hello@example.com>`. */
  from: string;
  timeoutMs?: number;
}

const addressOf = (value: string) => value.match(/<([^<>\s]+)>/)?.[1] ?? value.trim();

/** A header value that cannot start a new header. */
const clean = (value: string) => value.replace(/[\r\n]+/g, " ");

/** RFC 2047, so a subject outside ASCII survives. */
const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

export function buildMessage(mail: Mail, from: string, date: Date, messageId: string): string {
  const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${clean(from)}`,
    `To: ${clean(mail.to)}`,
    `Subject: ${encodeHeader(clean(mail.subject))}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
    "",
  ].join("\r\n");
}

export function smtpMailer(options: SmtpOptions): (mail: Mail) => Promise<void> {
  const url = new URL(options.url);
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") throw new Error("SMTP_URL must be smtp:// or smtps://");
  const port = Number(url.port) || (secure ? 465 : 25);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  if (user && !secure && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("refusing to send an SMTP password without TLS; use smtps://");
  }
  const sender = addressOf(options.from);
  const domain = sender.split("@")[1] ?? "localhost";

  return (mail) => new Promise<void>((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port });
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}`;
    const steps: { send: string | null; expect: number }[] = [
      { send: null, expect: 220 },
      { send: `EHLO ${domain}`, expect: 250 },
      ...(user ? [{ send: `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, expect: 235 }] : []),
      { send: `MAIL FROM:<${sender}>`, expect: 250 },
      { send: `RCPT TO:<${addressOf(mail.to)}>`, expect: 250 },
      { send: "DATA", expect: 354 },
      // Dot-stuffing: a body line that starts with a dot would otherwise end the message.
      { send: `${buildMessage(mail, options.from, new Date(), id).replace(/^\./gm, "..")}\r\n.`, expect: 250 },
      { send: "QUIT", expect: 221 },
    ];
    let step = 0;
    let buffer = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(options.timeoutMs ?? 20_000, () => finish(new Error("smtp timeout")));
    socket.on("error", () => finish(new Error("smtp connection failed")));
    socket.on("close", () => finish(new Error("smtp closed early")));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        // "250-…" continues a reply; "250 …" ends it.
        if (line[3] === "-") continue;
        const code = Number(line.slice(0, 3));
        if (code !== steps[step].expect) return finish(new Error(`smtp refused at step ${step} with ${code}`));
        step += 1;
        if (step >= steps.length) return finish();
        socket.write(`${steps[step].send}\r\n`);
      }
    });
  });
}
