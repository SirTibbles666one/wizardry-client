import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loginNsec: vi.fn(async (_key: string) => {}),
  onLogin: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({
    nsec: h.loginNsec,
    bunker: vi.fn(),
    extension: vi.fn(),
    nostrconnect: vi.fn(),
    getRelayUrls: () => [],
  }),
  generateNostrConnectParams: () => ({ clientSecretKey: new Uint8Array(32), clientPubkey: "a".repeat(64), secret: "s", relays: [] }),
  generateNostrConnectURI: () => "nostrconnect://client",
}));
vi.mock("@/lib/credentialManager", () => ({ getNsecCredential: async () => null }));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useLoggedInAccounts", () => ({ useLoggedInAccounts: () => ({ currentUser: null, accounts: [] }) }));
vi.mock("@/lib/shareOrigin", () => ({ shareOrigin: () => "https://armada.buzz" }));
vi.mock("@/components/auth/AndroidSignerOptions", () => ({ AndroidSignerOptions: () => null }));

import LoginScreen from "@/components/auth/LoginScreen";
import { encryptNsecToNcryptsec } from "@/lib/nip49";

const secretKey = generateSecretKey();
const nsec = nip19.nsecEncode(secretKey);
// The cheapest cost the spec allows, so the test does not run 64 MiB of scrypt twice.
const NCRYPTSEC = await encryptNsecToNcryptsec(nsec, "backup password", { logN: 14 });

const renderLogin = () => render(<LoginScreen isOpen onClose={h.onClose} onLogin={h.onLogin} />);

const keyInput = () => screen.getByPlaceholderText("nsec1…, ncryptsec1… or bunker://…");

beforeEach(() => {
  h.loginNsec.mockClear();
  h.onLogin.mockClear();
  h.onClose.mockClear();
});

describe("LoginScreen with a NIP-49 backup", () => {
  it("asks for the password once an ncryptsec1… value is pasted", async () => {
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: NCRYPTSEC } });

    expect(await screen.findByPlaceholderText("Password for this encrypted key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock and log in" })).toBeInTheDocument();
  });

  it("refuses to submit until the password is entered", async () => {
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: NCRYPTSEC } });

    expect(await screen.findByRole("button", { name: "Unlock and log in" })).toBeDisabled();
  });

  it("says so when the password is wrong, and does not log in", async () => {
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: NCRYPTSEC } });
    fireEvent.change(await screen.findByPlaceholderText("Password for this encrypted key"), {
      target: { value: "not the password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock and log in" }));

    expect(await screen.findByText("Wrong password for this backup. Check it and try again.")).toBeInTheDocument();
    expect(h.loginNsec).not.toHaveBeenCalled();
    expect(h.onLogin).not.toHaveBeenCalled();
  });

  it("unlocks with the right password and logs in with the key inside", async () => {
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: NCRYPTSEC } });
    fireEvent.change(await screen.findByPlaceholderText("Password for this encrypted key"), {
      target: { value: "backup password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock and log in" }));

    await waitFor(() => expect(h.loginNsec).toHaveBeenCalledWith(nsec));
    expect(h.onLogin).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("still takes a plain nsec without asking for a password", async () => {
    renderLogin();
    fireEvent.change(keyInput(), { target: { value: nsec } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(h.loginNsec).toHaveBeenCalledWith(nsec));
    expect(screen.queryByPlaceholderText("Password for this encrypted key")).not.toBeInTheDocument();
  });
});
