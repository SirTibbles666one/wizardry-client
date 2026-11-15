import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAccountState, setAccountSession } from "@/account/session";

const h = vi.hoisted(() => ({
  user: null as null | { pubkey: string; signer: { signEvent: (template: never) => Promise<unknown> } },
  logins: [] as unknown[],
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@nostrify/react/login", () => ({ useNostrLogin: () => ({ logins: h.logins }) }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn(async () => undefined) }));

import { AccountServerSettings } from "./AccountServerSettings";
import { accountWorld } from "./testWorld";

const EMAIL = "tibs@example.com";
const PASSWORD = "four small quiet sloths";
const TIMEOUT = { timeout: 10_000 };
let world: ReturnType<typeof accountWorld>;
let sk: Uint8Array;

beforeEach(() => {
  world = accountWorld();
  sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  h.user = { pubkey, signer: { signEvent: async (template) => finalizeEvent(template, sk) } };
  h.logins = [{ id: "login-1", type: "nsec", pubkey, data: { nsec: nip19.nsecEncode(sk) } }];
});
afterEach(() => world.close());

/** A confirmed account as a reload leaves it: token on disk, nothing unlocked in memory. */
async function signedIn({ withKey }: { withKey: boolean }) {
  await world.client.signUp(EMAIL, PASSWORD);
  const session = await world.client.confirmSignUp(EMAIL, PASSWORD, world.lastCode());
  const recoveryCode = withKey ? await world.client.storeKey(session, { sk: bytesToHex(sk) }) : null;
  localStorage.setItem("wizardry:account", JSON.stringify({ token: session.token, needsKey: false }));
  return { session, recoveryCode };
}

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("AccountServerSettings", () => {
  it("offers to store a key the account does not hold yet, and shows the recovery code once it has", async () => {
    await signedIn({ withKey: false });
    render(<AccountServerSettings />);
    fireEvent.click(await screen.findByText("Store your key in your account", undefined, TIMEOUT));
    type("Your password", PASSWORD);
    press("Store key");

    expect((await screen.findByTestId("recovery-code", undefined, TIMEOUT)).textContent).toMatch(/^.{5}-.{5}-.{5}-.{5}$/);
    expect((await world.client.signIn(EMAIL, PASSWORD)).contents).toEqual({ sk: bytesToHex(sk) });
    expect(await world.isMember(getPublicKey(sk))).toBe(true);
  });

  it("refuses a wrong password in plain words and changes nothing", async () => {
    await signedIn({ withKey: true });
    render(<AccountServerSettings />);
    fireEvent.click(await screen.findByText("Remove stored key", undefined, TIMEOUT));
    type("Your password", "not my password");
    press("Remove stored key");
    expect(await screen.findByRole("alert", undefined, TIMEOUT)).toHaveTextContent("That email and password don't match an account.");
    expect((await world.client.signIn(EMAIL, PASSWORD)).vault).not.toBeNull();
  });

  it("makes a new recovery code that replaces the old one", async () => {
    const { recoveryCode } = await signedIn({ withKey: true });
    render(<AccountServerSettings />);
    fireEvent.click(await screen.findByText("New recovery code", undefined, TIMEOUT));
    type("Your password", PASSWORD);
    press("Make new code");
    const fresh = (await screen.findByTestId("recovery-code", undefined, TIMEOUT)).textContent!;
    expect(fresh).not.toBe(recoveryCode);

    await world.client.startRecovery(EMAIL);
    await expect(world.client.recover(EMAIL, world.lastCode(), recoveryCode!, "another long password")).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("changes the password, keeps the key, and keeps this device signed in", async () => {
    const { session } = await signedIn({ withKey: true });
    render(<AccountServerSettings />);
    fireEvent.click(await screen.findByText("Change password", undefined, TIMEOUT));
    type("Your password", PASSWORD);
    type("New password", "a second long password");
    type("Password again", "a second long passwor");
    press("Change password");
    expect(screen.getByRole("alert")).toHaveTextContent("The two passwords don't match.");
    type("Password again", "a second long password");
    press("Change password");

    await waitFor(() => expect(getAccountState()?.token).not.toBe(session.token), TIMEOUT);
    expect((await world.client.signIn(EMAIL, "a second long password")).contents).toEqual({ sk: bytesToHex(sk) });
    await expect(world.client.signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(world.client.status(getAccountState()!.token)).resolves.toMatchObject({ hasVault: true });
  });

  it("deletes the email account, takes the key off the member list, and forgets the session", async () => {
    const { session } = await signedIn({ withKey: true });
    setAccountSession(await world.client.signIn(EMAIL, PASSWORD));
    await world.client.linkKey(getAccountState()!.token, async (template) => finalizeEvent(template, sk));
    expect(await world.isMember(getPublicKey(sk))).toBe(true);

    render(<AccountServerSettings />);
    fireEvent.click(await screen.findByText("Delete email account", undefined, TIMEOUT));
    expect(screen.getByText(/Your Nostr identity and messages are not touched/)).toBeInTheDocument();
    type("Your password", PASSWORD);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete email account" }).at(-1)!);

    await waitFor(() => expect(getAccountState()).toBeNull(), TIMEOUT);
    expect(await world.isMember(getPublicKey(sk))).toBe(false);
    await expect(world.client.signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(world.client.status(session.token)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("shows nothing without an account server or a session", () => {
    const { container } = render(<AccountServerSettings />);
    expect(container).toBeEmptyDOMElement();
  });
});
