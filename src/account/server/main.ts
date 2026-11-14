/**
 * The Wizardry account server's entry point: HTTP, SQLite and SMTP around
 * `core.ts`. Built to `server/account-server.mjs` by
 * vite.config.account-server.ts; run with `node server/account-server.mjs`.
 * Settings and deployment: docs/accounts.md.
 *
 * Nothing is logged per request: no address, no route with an identifier, no
 * caller IP. A line is written at start and when something breaks.
 */
import http from "node:http";

import { hexToBytes } from "@noble/hashes/utils.js";

import { createAccountServer, type Mail } from "./core";
import { smtpMailer } from "./mail";
import { sqliteStore } from "./sqliteStore";

const env = process.env;
const required = (name: string): string => {
  const value = env[name];
  if (!value) {
    console.error(`${name} is required. See docs/accounts.md.`);
    process.exit(1);
  }
  return value;
};

const pepperHex = required("ACCOUNT_PEPPER");
if (!/^[0-9a-f]{64,}$/.test(pepperHex)) {
  console.error("ACCOUNT_PEPPER must be at least 64 hex characters (openssl rand -hex 32).");
  process.exit(1);
}
const publicUrl = required("ACCOUNT_PUBLIC_URL");
const origins = (env.ACCOUNT_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";
/** How many proxies sit in front; the caller's address is read that many hops from the end of X-Forwarded-For. */
const trustedProxies = Number(env.ACCOUNT_TRUSTED_PROXIES ?? 0);

let sendMail: (mail: Mail) => Promise<void>;
if (env.SMTP_URL) {
  sendMail = smtpMailer({ url: env.SMTP_URL, from: required("MAIL_FROM") });
} else if (env.ACCOUNT_DEV_MAIL === "console") {
  // Development only: codes are printed instead of sent.
  sendMail = async (mail) => console.log(`[dev mail] ${mail.subject}`);
} else {
  console.error("SMTP_URL is required (or ACCOUNT_DEV_MAIL=console for local development).");
  process.exit(1);
}

const store = sqliteStore(env.ACCOUNT_DB ?? "accounts.db");
const server = createAccountServer({
  store,
  pepper: hexToBytes(pepperHex),
  sendMail,
  now: () => Date.now(),
  publicUrl,
  appName: env.APP_NAME ?? "Wizardry",
  memberToken: env.ACCOUNT_MEMBER_TOKEN,
});

const MAX_BODY = 8 * 1024;

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !(origins.includes("*") || origins.includes(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function callerIp(request: http.IncomingMessage): string {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (trustedProxies > 0 && forwarded.length >= trustedProxies) return forwarded[forwarded.length - trustedProxies];
  return request.socket.remoteAddress ?? "unknown";
}

http.createServer((request, response) => {
  const cors = corsHeaders(request.headers.origin);
  const send = (status: number, body: Record<string, unknown>) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors });
    response.end(JSON.stringify(body));
  };
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  if (request.method === "GET" && path === "/healthz") return send(200, { ok: true });
  if (request.method !== "POST" || !path.startsWith("/v1/")) return send(404, { error: "not_found" });
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) return send(400, { error: "bad_request" });

  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      send(413, { error: "bad_request" });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (size > MAX_BODY) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return send(400, { error: "bad_request" });
    }
    const bearer = String(request.headers.authorization ?? "").match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    const memberToken = request.headers["x-member-token"];
    server
      .handle({ route: path.slice("/v1/".length), body, bearer, ip: callerIp(request), memberToken: typeof memberToken === "string" ? memberToken : undefined })
      .then((answer) => send(answer.status, answer.body))
      .catch((error: unknown) => {
        console.error("account server error:", error instanceof Error ? error.name : "unknown");
        send(500, { error: "bad_request" });
      });
  });
}).listen(port, host, () => {
  console.log(`account server listening on ${host}:${port}`);
});

const stop = () => {
  store.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
