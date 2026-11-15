import { render, screen, waitFor } from "@testing-library/react";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAccountState, setAccountSession } from "@/account/session";
import { _resetBeforeAccountExitForTests, runBeforeAccountExit } from "@/lib/beforeAccountExit";

const h = vi.hoisted(() => ({
  user: null as null | { pubkey: string; signer: { signEvent: (template: never) => Promise<unknown> } },
  logins: [] as unknown[],
  removeLogin: vi.fn(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@nostrify/react/login", () => ({ useNostrLogin: () => ({ logins: h.logins }) }));
vi.mock("@/hooks/useLoggedInAccounts", () => ({
  useLoggedInAccounts: () => ({ removeLogin: h.removeLogin, currentUser: h.user ? { id: "login-1" } : undefined }),
}));
vi.mock("@/hooks/useLoginActions", () => ({ useLoginActions: () => ({ nsec: vi.fn() }) }));

import { AccountKeySync } from "./AccountKeySync";
import { accountWorld } from "./testWorld";

const EMAIL = "tibs@example.com";
const PASSWORD = "four small quiet sloths";
const TIMEOUT = { timeout: 10_000 };
let world: ReturnType<typeof accountWorld>;

function loginWith(sk: Uint8Array, type: "nsec" | "extension") {
  const pubkey = getPublicKey(sk);
  h.user = { pubkey, signer: { signEvent: async (template) => finalizeEvent(template, sk) } };
  h.logins = [type === "nsec" ? { id: "login-1", type, pubkey, data: { nsec: nip19.nsecEncode(sk) } } : { id: "login-1", type, pubkey, data: null }];
  return pubkey;
}

beforeEach(() => {
  h.user = null;
  h.logins = [];
  h.removeLogin.mockClear();
  _resetBeforeAccountExitForTests();
  world = accountWorld();
});
afterEach(() => world.close());

async function freshAccount() {
  await world.client.signUp(EMAIL, PASSWORD);
  return world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
}

describe("AccountKeySync", () => {
  it("locks a new account's nsec into the vault, shows the recovery code, and links the key", async () => {
    const sk = generateSecretKey();
    const pubkey = loginWith(sk, "nsec");
    setAccountSession(await freshAccount());
    render(<AccountKeySync />);

    expect((await screen.findByTestId("recovery-code", undefined, TIMEOUT)).textContent).toMatch(/^.{5}-.{5}-.{5}-.{5}$/);
    await waitFor(() => expect(getAccountState()?.needsKey).toBe(false), TIMEOUT);
    expect(await world.isMember(pubkey)).toBe(true);
    expect((await world.client.signIn(EMAIL, PASSWORD)).contents).toEqual({ sk: bytesToHex(sk) });
  });

  it("links an extension's key by proof and never stores it", async () => {
    const pubkey = loginWith(generateSecretKey(), "extension");
    setAccountSession(await freshAccount());
    render(<AccountKeySync />);

    await waitFor(() => expect(getAccountState()?.needsKey).toBe(false), TIMEOUT);
    expect(await world.isMember(pubkey)).toBe(true);
    expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument();
    const again = await world.client.signIn(EMAIL, PASSWORD);
    expect(again.vault).toBeNull();
    expect(again.keyLinked).toBe(true);
  });

  it("asks someone logged in without an account for one, with logging out as the only way round", async () => {
    loginWith(generateSecretKey(), "nsec");
    render(<AccountKeySync />);
    expect(await screen.findByRole("heading", { name: "sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Log out instead" }).click();
    expect(h.removeLogin).toHaveBeenCalledWith("login-1");
  });

  it("asks for the password again when a reload has forgotten the vault key mid-setup", async () => {
    loginWith(generateSecretKey(), "nsec");
    const session = await freshAccount();
    // What survives a reload: the token and the debt, not the unlocked session.
    localStorage.setItem("wizardry:account", JSON.stringify({ token: session.token, needsKey: true }));
    render(<AccountKeySync />);
    expect(await screen.findByRole("heading", { name: "sign in" })).toBeInTheDocument();
  });

  it("ends the server session on the last logout", async () => {
    const sk = generateSecretKey();
    loginWith(sk, "nsec");
    const session = await freshAccount();
    setAccountSession(session);
    render(<AccountKeySync />);
    await waitFor(() => expect(getAccountState()?.needsKey).toBe(false), TIMEOUT);

    await runBeforeAccountExit("final-logout");
    expect(getAccountState()).toBeNull();
    await expect(world.client.forgetKey(session.token)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does nothing at all without an account server", () => {
    delete (window as unknown as { ENV?: unknown }).ENV;
    loginWith(generateSecretKey(), "nsec");
    const { container } = render(<AccountKeySync />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "sign in" })).not.toBeInTheDocument();
  });
});
