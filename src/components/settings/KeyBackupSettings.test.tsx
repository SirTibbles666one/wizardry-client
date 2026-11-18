// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  saveNsec: vi.fn(async () => {}),
  exportNcryptsec: vi.fn(),
  share: vi.fn(async () => {}),
  writeClipboardText: vi.fn(async (_text: string) => {}),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
vi.mock("@/lib/share", () => ({ share: h.share }));
vi.mock("@/lib/credentialManager", () => ({
  saveNsec: h.saveNsec,
  exportNcryptsec: h.exportNcryptsec,
}));
vi.mock("@/lib/secureStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/secureStorage")>();
  return { ...actual, keyStorageTier: async () => "plaintext" as const };
});
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web", isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}));

import { KeyBackupSettings } from "@/components/settings/KeyBackupSettings";
import { keyBackupPending, markKeyBackupPending } from "@/lib/keyBackup";
import { decryptNcryptsecToNsec, isNcryptsec } from "@/lib/nip49";

const sk = generateSecretKey();
const nsec = nip19.nsecEncode(sk);
const pubkey = getPublicKey(sk);

beforeEach(() => {
  localStorage.clear();
  h.exportNcryptsec.mockReset();
  h.toast.mockClear();
  markKeyBackupPending(pubkey);
});

/** Open the password form and fill it in. */
const fillPassword = (password = "a long password", confirmation = password) => {
  fireEvent.click(screen.getByRole("button", { name: "Back up with a password" }));
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: confirmation } });
};

describe("KeyBackupSettings encrypted backup", () => {
  it("saves a NIP-49 key that this app can read back", async () => {
    h.exportNcryptsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    render(<KeyBackupSettings nsec={nsec} pubkey={pubkey} />);

    fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    await waitFor(() => expect(h.exportNcryptsec).toHaveBeenCalledTimes(1));
    const [ncryptsec] = h.exportNcryptsec.mock.calls[0] as [string];
    expect(isNcryptsec(ncryptsec)).toBe(true);
    expect(ncryptsec).not.toContain(nsec);
    expect(await decryptNcryptsecToNsec(ncryptsec, "a long password")).toBe(nsec);
  });

  it("counts as a backup, so the reminder stops asking", async () => {
    h.exportNcryptsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    render(<KeyBackupSettings nsec={nsec} pubkey={pubkey} />);
    expect(keyBackupPending(pubkey)).toBe(true);

    fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    await waitFor(() => expect(keyBackupPending(pubkey)).toBe(false));
  });

  it("never writes an unsealed key: it goes to the file only", async () => {
    h.exportNcryptsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    render(<KeyBackupSettings nsec={nsec} pubkey={pubkey} />);

    fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    await waitFor(() => expect(h.exportNcryptsec).toHaveBeenCalled());
    // The keyring path (saveNsec) stores the raw nsec; this route must not use it.
    expect(h.saveNsec).not.toHaveBeenCalled();
  });

  it("refuses two passwords that do not match, and saves nothing", async () => {
    render(<KeyBackupSettings nsec={nsec} pubkey={pubkey} />);

    fillPassword("a long password", "a different one");
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(h.exportNcryptsec).not.toHaveBeenCalled();
  });

  it("refuses a password below the floor", async () => {
    render(<KeyBackupSettings nsec={nsec} pubkey={pubkey} />);

    fillPassword("short", "short");
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    expect(await screen.findByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(h.exportNcryptsec).not.toHaveBeenCalled();
  });
});
