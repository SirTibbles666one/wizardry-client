import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  backUpNsec: vi.fn(),
  exportNcryptsec: vi.fn(),
  writeClipboardText: vi.fn(async (_text: string) => {}),
}));

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
vi.mock("@/lib/credentialManager", () => ({
  backUpNsec: h.backUpNsec,
  exportNcryptsec: h.exportNcryptsec,
}));

import { BackupKeyDialog } from "@/components/auth/BackupKeyDialog";
import { keyBackupPending, markKeyBackupPending } from "@/lib/keyBackup";
import { decryptNcryptsecToNsec, isNcryptsec } from "@/lib/nip49";

const sk = generateSecretKey();
const nsec = nip19.nsecEncode(sk);
const pubkey = getPublicKey(sk);

beforeEach(() => {
  localStorage.clear();
  h.backUpNsec.mockReset();
  h.exportNcryptsec.mockReset();
  h.writeClipboardText.mockClear();
  markKeyBackupPending(pubkey);
});

describe("BackupKeyDialog", () => {
  it("clears the pending backup once the key is copied", async () => {
    const onOpenChange = vi.fn();
    render(<BackupKeyDialog open onOpenChange={onOpenChange} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Show key" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    await waitFor(() => expect(keyBackupPending(pubkey)).toBe(false));
    expect(h.writeClipboardText).toHaveBeenCalledWith(nsec);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the backup pending when the save is cancelled", async () => {
    h.backUpNsec.mockResolvedValue({ status: "cancelled" });
    render(<BackupKeyDialog open onOpenChange={vi.fn()} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(h.backUpNsec).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save key" })).not.toBeDisabled());
    expect(keyBackupPending(pubkey)).toBe(true);
  });

  it("stands between logout and an account with no backup", async () => {
    h.backUpNsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    const onLogout = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <BackupKeyDialog open onOpenChange={onOpenChange} nsec={nsec} pubkey={pubkey} onLogout={onLogout} />,
    );

    expect(screen.getByText("back up before logging out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out anyway" })).toBeInTheDocument();

    // Backing up keeps the dialog open so the user can finish logging out.
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(keyBackupPending(pubkey)).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("writes a NIP-49 backup that this app can read back", async () => {
    render(<BackupKeyDialog open onOpenChange={vi.fn()} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Back up with a password" }));
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "a long password" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: "a long password" } });
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    const encryptedField = await screen.findByLabelText("Encrypted key");
    await waitFor(() => expect((encryptedField as HTMLInputElement).value).toMatch(/^ncryptsec1/));

    const ncryptsec = (encryptedField as HTMLInputElement).value;
    expect(isNcryptsec(ncryptsec)).toBe(true);
    expect(await decryptNcryptsecToNsec(ncryptsec, "a long password")).toBe(nsec);
    // A backup from the web build is honest about the key having been stored unencrypted.
    expect(isNcryptsec(ncryptsec)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show key" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy encrypted key" }));
    await waitFor(() => expect(h.writeClipboardText).toHaveBeenCalledWith(ncryptsec));
    expect(keyBackupPending(pubkey)).toBe(false);
  });

  it("saves the encrypted key to a file, never the keyring", async () => {
    h.exportNcryptsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    render(<BackupKeyDialog open onOpenChange={vi.fn()} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Back up with a password" }));
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "a long password" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: "a long password" } });
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));
    await waitFor(() => expect((screen.getByLabelText("Encrypted key") as HTMLInputElement).value).toMatch(/^ncryptsec1/));

    fireEvent.click(screen.getByRole("button", { name: "Save encrypted key" }));
    await waitFor(() => expect(h.exportNcryptsec).toHaveBeenCalledWith(expect.stringMatching(/^ncryptsec1/)));
    expect(h.backUpNsec).not.toHaveBeenCalled();
    await waitFor(() => expect(keyBackupPending(pubkey)).toBe(false));
  });

  it("refuses two passwords that do not match, and makes no backup", async () => {
    render(<BackupKeyDialog open onOpenChange={vi.fn()} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Back up with a password" }));
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "a long password" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: "a different one" } });
    fireEvent.click(screen.getByRole("button", { name: "Encrypt key" }));

    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Encrypted key")).not.toBeInTheDocument();
    expect(keyBackupPending(pubkey)).toBe(true);
  });
});
