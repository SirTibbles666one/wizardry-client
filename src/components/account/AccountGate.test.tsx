import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAccountState } from "@/account/session";

const h = vi.hoisted(() => ({ nsec: vi.fn(async (_nsec: string) => undefined), logins: [] as { pubkey: string }[] }));

vi.mock("@/hooks/useLoginActions", () => ({ useLoginActions: () => ({ nsec: h.nsec }) }));
vi.mock("@nostrify/react/login", () => ({ useNostrLogin: () => ({ logins: h.logins }) }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn(async () => undefined) }));

import { AccountGate } from "./AccountGate";
import { accountWorld } from "./testWorld";

const EMAIL = "tibs@example.com";
const PASSWORD = "four small quiet sloths";
let world: ReturnType<typeof accountWorld>;

beforeEach(() => {
  h.nsec.mockClear();
  h.logins = [];
  world = accountWorld();
});
afterEach(() => world.close());

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const TIMEOUT = { timeout: 10_000 };

function renderGate() {
  const onLogin = vi.fn();
  const onClose = vi.fn();
  render(<AccountGate isOpen onClose={onClose} onLogin={onLogin} />);
  return { onLogin, onClose };
}

describe("AccountGate", () => {
  it("creates an account with an emailed code and leaves the key to be chosen next", async () => {
    const { onLogin } = renderGate();
    press("New here? Create an account");
    type("Email", EMAIL);
    type("New password", PASSWORD);
    type("Password again", PASSWORD);
    press("Create account");

    await screen.findByText(/We sent a six-digit code to tibs@example.com/, undefined, TIMEOUT);
    type("Code from your email", world.lastCode());
    press("Confirm");

    await waitFor(() => expect(getAccountState()?.needsKey).toBe(true), TIMEOUT);
    expect(getAccountState()?.unlocked).not.toBeNull();
    // No key yet, so nothing was logged in: the key screen comes next.
    expect(h.nsec).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("signs in and logs in the key the account holds", async () => {
    const sk = generateSecretKey();
    await world.client.signUp(EMAIL, PASSWORD);
    const session = await world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
    await world.client.storeKey(session, { sk: bytesToHex(sk) });

    const { onLogin, onClose } = renderGate();
    type("Email", "  Tibs@Example.com ");
    type("Password", PASSWORD);
    press("Sign in");

    await waitFor(() => expect(h.nsec).toHaveBeenCalledWith(nip19.nsecEncode(sk)), TIMEOUT);
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(getAccountState()?.needsKey).toBe(false);
  });

  it("says so in plain words when the password is wrong, and checks a new one before sending it", async () => {
    await world.client.signUp(EMAIL, PASSWORD);
    await world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
    renderGate();
    type("Email", EMAIL);
    type("Password", "not the password");
    press("Sign in");
    expect(await screen.findByRole("alert", undefined, TIMEOUT)).toHaveTextContent("That email and password don't match an account.");
    expect(h.nsec).not.toHaveBeenCalled();

    press("New here? Create an account");
    type("Email", "not-an-email");
    press("Create account");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a full email address.");
    type("Email", "new@example.com");
    type("New password", "short");
    type("Password again", "short");
    press("Create account");
    expect(screen.getByRole("alert")).toHaveTextContent("Use at least 10 characters.");
    type("New password", PASSWORD);
    type("Password again", `${PASSWORD}!`);
    press("Create account");
    expect(screen.getByRole("alert")).toHaveTextContent("The two passwords don't match.");
    expect(world.outbox).toHaveLength(1);
  });

  it("recovers the key with the emailed code and the recovery code, and shows the new code before going on", async () => {
    const sk = generateSecretKey();
    await world.client.signUp(EMAIL, PASSWORD);
    const session = await world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
    const recoveryCode = await world.client.storeKey(session, { sk: bytesToHex(sk) });

    const { onLogin } = renderGate();
    press("Forgot password");
    type("Email", EMAIL);
    press("Email me a code");
    await screen.findByLabelText("Recovery code", undefined, TIMEOUT);
    type("Code from your email", world.lastCode());
    type("Recovery code", recoveryCode.toLowerCase());
    type("New password", "a different long password");
    type("Password again", "a different long password");
    press("Set password");

    const shown = await screen.findByTestId("recovery-code", undefined, TIMEOUT);
    expect(shown.textContent).toMatch(/^.{5}-.{5}-.{5}-.{5}$/);
    expect(shown.textContent).not.toBe(recoveryCode);
    // Not until the new code is saved.
    expect(screen.getByRole("button", { name: "I've saved it" })).toBeDisabled();
    expect(h.nsec).not.toHaveBeenCalled();
    press("Copy");
    await waitFor(() => expect(screen.getByRole("button", { name: "I've saved it" })).toBeEnabled());
    press("I've saved it");

    await waitFor(() => expect(h.nsec).toHaveBeenCalledWith(nip19.nsecEncode(sk)), TIMEOUT);
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect((await world.client.signIn(EMAIL, "a different long password")).contents).toEqual({ sk: bytesToHex(sk) });
  });

  it("warns what starting over costs before doing it", async () => {
    await world.client.signUp(EMAIL, PASSWORD);
    const session = await world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
    await world.client.storeKey(session, { sk: bytesToHex(generateSecretKey()) });

    renderGate();
    press("Forgot password");
    type("Email", EMAIL);
    press("Email me a code");
    await screen.findByLabelText("Recovery code", undefined, TIMEOUT);
    press("I've lost my recovery code");
    expect(screen.getByText(/Your old one is lost for good/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery code")).not.toBeInTheDocument();
    type("Code from your email", world.lastCode());
    type("New password", "starting over again");
    type("Password again", "starting over again");
    press("Start over with a new key");

    await waitFor(() => expect(getAccountState()?.needsKey).toBe(true), TIMEOUT);
    expect(h.nsec).not.toHaveBeenCalled();
  });
});
