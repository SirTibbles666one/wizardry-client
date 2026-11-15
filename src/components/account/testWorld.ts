/**
 * A real account server (the shipped rules over an in-memory store) behind
 * `fetch`, for component tests: what the screens talk to is what production runs.
 */
import { vi } from "vitest";

import { createAccountClient } from "@/account/client";
import { createAccountServer, memoryStore, type Mail } from "@/account/server/core";
import { _resetAccountSessionForTests } from "@/account/session";

export const ACCOUNT_URL = "https://accounts.example";

export function accountWorld() {
  const outbox: Mail[] = [];
  const store = memoryStore();
  const server = createAccountServer({
    store,
    pepper: new Uint8Array(32).fill(3),
    sendMail: async (mail) => void outbox.push(mail),
    now: () => Date.now(),
    publicUrl: ACCOUNT_URL,
    appName: "Wizardry",
    memberToken: "relay-secret",
  });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const answer = await server.handle({
      route: String(input).replace(`${ACCOUNT_URL}/v1/`, ""),
      body: JSON.parse(String(init?.body ?? "{}")),
      ip: "203.0.113.9",
      bearer: headers.authorization?.replace("Bearer ", ""),
      memberToken: headers["x-member-token"],
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;

  (window as unknown as { ENV?: Record<string, string> }).ENV = { ACCOUNT_SERVER: ACCOUNT_URL };
  vi.stubGlobal("fetch", doFetch);
  localStorage.clear();
  _resetAccountSessionForTests();

  return {
    store,
    outbox,
    client: createAccountClient({ baseUrl: ACCOUNT_URL, fetch: doFetch }),
    lastCode: () => outbox.at(-1)!.subject.match(/^(\d{6}) /)![1],
    isMember: async (pubkey: string) =>
      (await server.handle({ route: "member/check", body: { pubkey }, ip: "relay", memberToken: "relay-secret" })).body.member,
    close() {
      vi.unstubAllGlobals();
      delete (window as unknown as { ENV?: unknown }).ENV;
      localStorage.clear();
      _resetAccountSessionForTests();
    },
  };
}
