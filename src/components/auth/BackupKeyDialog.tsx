import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, Eye, KeyRound, Lock, LogOut } from "lucide-react";
import { nip19 } from "nostr-tools";

import { Button } from "@/components/ui/button";
import {
  ChromeDialogContent,
  ChromeDialogFooter,
  ChromeDialogHeader,
  Dialog,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec, exportNcryptsec } from "@/lib/credentialManager";
import { clearKeyBackupPending } from "@/lib/keyBackup";
import { encryptNsecToNcryptsec, keySecurityFor } from "@/lib/nip49";
import { keyStorageTier } from "@/lib/secureStorage";

interface BackupKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nsec: string;
  pubkey: string;
  /**
   * Logout mode: the dialog stands between "Log out" and an account that exists
   * nowhere else. Stays open after a backup so the user can finish logging out.
   */
  onLogout?: () => void;
}

/** Shortest password this dialog will accept for a NIP-49 backup. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Back up a key signup minted without asking. Copy, file, keyring all count:
 * each clears the pending marker ({@link clearKeyBackupPending}).
 *
 * A second route writes a NIP-49 `ncryptsec`: the key stays usable, but only
 * with a password, so the backup is worth nothing to whoever finds the file.
 */
export function BackupKeyDialog({ open, onOpenChange, nsec, pubkey, onLogout }: BackupKeyDialogProps) {
  const intl = useIntl();
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  // NIP-49 password-encrypted backup.
  const [encryptedMode, setEncryptedMode] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [encrypting, setEncrypting] = useState(false);
  const [ncryptsec, setNcryptsec] = useState("");
  const [copiedEncrypted, setCopiedEncrypted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowKey(false);
    setCopied(false);
    setBackedUp(false);
    setEncryptedMode(false);
    setPassword("");
    setConfirmation("");
    setPasswordError("");
    setNcryptsec("");
    setCopiedEncrypted(false);
  }, [open]);

  const done = () => {
    setBackedUp(true);
    clearKeyBackupPending(pubkey);
    if (!onLogout) onOpenChange(false);
  };

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: t({ id: "backupKeyDialog.copiedToast.title", defaultMessage: "Key copied" }),
        description: t({
          id: "backupKeyDialog.copiedToast.description",
          defaultMessage: "Paste it somewhere safe, like a password manager.",
        }),
      });
      done();
    } catch {
      toast({
        title: t({ id: "backupKeyDialog.copyFailed.title", defaultMessage: "Copy failed" }),
        description: t({
          id: "backupKeyDialog.copyFailed.description",
          defaultMessage: "Could not copy to the clipboard. Please select and copy it manually.",
        }),
        variant: "destructive",
      });
    }
  };

  // "Save as…" on web, Credential Manager on Android, Files on iOS.
  const saveKey = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await backUpNsec(nip19.npubEncode(pubkey), nsec);
      if (result.status === "cancelled") return;
      if (result.status === "failed") {
        toast({
          title: t({ id: "backupKeyDialog.saveFailed.title", defaultMessage: "Couldn't save your key" }),
          description: t({
            id: "backupKeyDialog.saveFailed.description",
            defaultMessage: "Saving failed. Reveal your key, copy it, and store it somewhere safe.",
          }),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: t({ id: "backupKeyDialog.saved.title", defaultMessage: "Key saved" }),
        description: t(
          { id: "backupKeyDialog.saved.description", defaultMessage: "Saved to {location}. Keep it safe. It's your only login." },
          { location: result.location },
        ),
      });
      done();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Encrypt with the password the user chose. The key-security byte records how
   * this device holds the key at rest, so the backup tells the truth about
   * whether the key has been sitting somewhere unencrypted.
   */
  const encryptKey = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(
        t(
          { id: "backupKeyDialog.passwordTooShort", defaultMessage: "Use at least {count} characters." },
          { count: MIN_PASSWORD_LENGTH },
        ),
      );
      return;
    }
    if (password !== confirmation) {
      setPasswordError(t({ id: "backupKeyDialog.passwordMismatch", defaultMessage: "The two passwords don't match." }));
      return;
    }

    setPasswordError("");
    setEncrypting(true);
    try {
      const keySecurity = keySecurityFor(await keyStorageTier());
      setNcryptsec(await encryptNsecToNcryptsec(nsec, password, { keySecurity }));
      setPassword("");
      setConfirmation("");
    } catch {
      setPasswordError(t({ id: "backupKeyDialog.encryptFailed", defaultMessage: "Couldn't encrypt this key. Try again." }));
    } finally {
      setEncrypting(false);
    }
  };

  const copyEncrypted = async () => {
    try {
      await writeClipboardText(ncryptsec);
      setCopiedEncrypted(true);
      setTimeout(() => setCopiedEncrypted(false), 2000);
      toast({
        title: t({ id: "backupKeyDialog.encryptedCopied.title", defaultMessage: "Encrypted key copied" }),
        description: t({
          id: "backupKeyDialog.encryptedCopied.description",
          defaultMessage: "It needs your password to open. Keep the two apart.",
        }),
      });
      done();
    } catch {
      toast({
        title: t({ id: "backupKeyDialog.copyFailed.title", defaultMessage: "Copy failed" }),
        description: t({
          id: "backupKeyDialog.copyFailed.description",
          defaultMessage: "Could not copy to the clipboard. Please select and copy it manually.",
        }),
        variant: "destructive",
      });
    }
  };

  const saveEncrypted = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await exportNcryptsec(ncryptsec);
      if (result.status === "cancelled") return;
      if (result.status === "failed") {
        toast({
          title: t({ id: "backupKeyDialog.saveFailed.title", defaultMessage: "Couldn't save your key" }),
          description: t({
            id: "backupKeyDialog.encryptedSaveFailed",
            defaultMessage: "Saving failed. Copy the encrypted key and store it somewhere safe.",
          }),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: t({ id: "backupKeyDialog.encryptedSaved.title", defaultMessage: "Encrypted key saved" }),
        description: t(
          {
            id: "backupKeyDialog.encryptedSaved.description",
            defaultMessage: "Saved to {location}. You'll need that password to use it.",
          },
          { location: result.location },
        ),
      });
      done();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={
          onLogout
            ? intl.formatMessage({ id: "backupKeyDialog.logoutTitle", defaultMessage: "Back up before logging out" })
            : intl.formatMessage({ id: "backupKeyDialog.title", defaultMessage: "Back up your secret key" })
        }
      >
        <ChromeDialogHeader
          icon={onLogout ? LogOut : KeyRound}
          tone={onLogout ? "destructive" : "primary"}
          title={
            onLogout
              ? intl.formatMessage({ id: "backupKeyDialog.logoutHeading", defaultMessage: "back up before logging out" })
              : intl.formatMessage({ id: "backupKeyDialog.heading", defaultMessage: "back up your secret key" })
          }
          description={
            onLogout
              ? intl.formatMessage({
                  id: "backupKeyDialog.logoutDescription",
                  defaultMessage: "Your key isn't backed up anywhere. Log out without it and this account is gone for good.",
                })
              : intl.formatMessage({
                  id: "backupKeyDialog.description",
                  defaultMessage:
                    "Your account lives only on this device. Save your key so you can sign in anywhere, and never lose it.",
                })
          }
        />

        <div className="mt-5 space-y-4">
          <div className="clip-corner-lg bg-destructive/10 p-3.5 text-left">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="text-xs font-bold uppercase tracking-widest text-destructive">
                  <FormattedMessage id="backupKeyDialog.onlyLogin" defaultMessage="This key is your only login" />
                </p>
                <p className="text-xs leading-relaxed text-destructive/90">
                  <FormattedMessage
                    id="backupKeyDialog.noReset"
                    defaultMessage="There's no email or password, and it can't be reset. Anyone you share it with can act as you."
                  />
                </p>
              </div>
            </div>
          </div>

          {encryptedMode ? (
            ncryptsec ? (
              <>
                {/* The encrypted key itself: reveal, then copy, like the plain one. */}
                <div className="relative w-full">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={ncryptsec}
                    readOnly
                    aria-label={intl.formatMessage({ id: "backupKeyDialog.encryptedKey", defaultMessage: "Encrypted key" })}
                    className="pr-10 font-mono bg-background border-transparent"
                  />
                  {showKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      onClick={copyEncrypted}
                      aria-label={
                        copiedEncrypted
                          ? intl.formatMessage({ id: "backupKeyDialog.keyCopied", defaultMessage: "Key copied" })
                          : intl.formatMessage({ id: "backupKeyDialog.copyEncrypted", defaultMessage: "Copy encrypted key" })
                      }
                      title={
                        copiedEncrypted
                          ? intl.formatMessage(common.copied)
                          : intl.formatMessage({ id: "backupKeyDialog.copyEncrypted", defaultMessage: "Copy encrypted key" })
                      }
                    >
                      {copiedEncrypted ? <Check className="size-4 text-success" /> : <Copy className="size-4 text-muted-foreground" />}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      onClick={() => setShowKey(true)}
                      aria-label={intl.formatMessage({ id: "backupKeyDialog.showKey", defaultMessage: "Show key" })}
                      title={intl.formatMessage({ id: "backupKeyDialog.showKey", defaultMessage: "Show key" })}
                    >
                      <Eye className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  <FormattedMessage
                    id="backupKeyDialog.encryptedWarning"
                    defaultMessage="This is a NIP-49 encrypted key: it logs in with the password you just set. Lose the password and the backup is worthless."
                  />
                </p>

                <Button
                  type="button"
                  size="lg"
                  variant={backedUp ? "secondary" : "default"}
                  className="h-12 w-full clip-corner-lg text-base font-medium"
                  onClick={saveEncrypted}
                  disabled={saving}
                >
                  <Download className="size-4" />
                  {saving ? (
                    <FormattedMessage {...common.saving} />
                  ) : (
                    <FormattedMessage id="backupKeyDialog.saveEncryptedKey" defaultMessage="Save encrypted key" />
                  )}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground text-left">
                  <FormattedMessage
                    id="backupKeyDialog.encryptedDescription"
                    defaultMessage="Pick a password for the backup. The file it saves is useless without it — and so is the backup if you forget it."
                  />
                </p>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (passwordError) setPasswordError("");
                  }}
                  placeholder={intl.formatMessage({ id: "backupKeyDialog.password", defaultMessage: "Password" })}
                  aria-label={intl.formatMessage({ id: "backupKeyDialog.password", defaultMessage: "Password" })}
                  autoComplete="new-password"
                  autoFocus
                  className="bg-background border-transparent"
                />
                <Input
                  type="password"
                  value={confirmation}
                  onChange={(e) => {
                    setConfirmation(e.target.value);
                    if (passwordError) setPasswordError("");
                  }}
                  placeholder={intl.formatMessage({ id: "backupKeyDialog.confirmPassword", defaultMessage: "Confirm password" })}
                  aria-label={intl.formatMessage({ id: "backupKeyDialog.confirmPassword", defaultMessage: "Confirm password" })}
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void encryptKey();
                    }
                  }}
                  className="bg-background border-transparent"
                />
                {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}

                <Button
                  type="button"
                  size="lg"
                  variant="default"
                  className="h-12 w-full clip-corner-lg text-base font-medium"
                  onClick={encryptKey}
                  disabled={encrypting || !password || !confirmation}
                >
                  <Lock className="size-4" />
                  {encrypting ? (
                    <FormattedMessage id="backupKeyDialog.encrypting" defaultMessage="Encrypting…" />
                  ) : (
                    <FormattedMessage id="backupKeyDialog.encryptKey" defaultMessage="Encrypt key" />
                  )}
                </Button>

                <button
                  type="button"
                  onClick={() => {
                    setEncryptedMode(false);
                    setPassword("");
                    setConfirmation("");
                    setPasswordError("");
                  }}
                  className="w-full text-sm text-muted-foreground hover:text-foreground"
                >
                  <FormattedMessage id="backupKeyDialog.usePlainKey" defaultMessage="Save the key itself instead" />
                </button>
              </>
            )
          ) : (
            <>
              {/* Reveal, then copy. No hide: that would only remove the copy button. */}
              <div className="relative w-full">
                <Input
                  type={showKey ? "text" : "password"}
                  value={nsec}
                  readOnly
                  className="pr-10 font-mono bg-background border-transparent"
                />
                {showKey ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={copyKey}
                    aria-label={
                      copied
                        ? intl.formatMessage({ id: "backupKeyDialog.keyCopied", defaultMessage: "Key copied" })
                        : intl.formatMessage({ id: "backupKeyDialog.copyKey", defaultMessage: "Copy key" })
                    }
                    title={
                      copied
                        ? intl.formatMessage(common.copied)
                        : intl.formatMessage({ id: "backupKeyDialog.copyKey", defaultMessage: "Copy key" })
                    }
                  >
                    {copied ? (
                      <Check className="size-4 text-success" />
                    ) : (
                      <Copy className="size-4 text-muted-foreground" />
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={() => setShowKey(true)}
                    aria-label={intl.formatMessage({ id: "backupKeyDialog.showKey", defaultMessage: "Show key" })}
                    title={intl.formatMessage({ id: "backupKeyDialog.showKey", defaultMessage: "Show key" })}
                  >
                    <Eye className="size-4 text-muted-foreground" />
                  </Button>
                )}
              </div>

              <Button
                type="button"
                size="lg"
                variant={backedUp ? "secondary" : "default"}
                className="h-12 w-full clip-corner-lg text-base font-medium"
                onClick={saveKey}
                disabled={saving}
              >
                <Download className="size-4" />
                {saving ? (
                  <FormattedMessage {...common.saving} />
                ) : (
                  <FormattedMessage id="backupKeyDialog.saveKey" defaultMessage="Save key" />
                )}
              </Button>

              {/* NIP-49: the safer habit — a backup that is worthless to a finder. */}
              <Button
                type="button"
                size="lg"
                variant="secondary"
                className="h-12 w-full clip-corner-lg"
                onClick={() => setEncryptedMode(true)}
              >
                <Lock className="size-4" />
                <FormattedMessage id="backupKeyDialog.encryptWithPassword" defaultMessage="Back up with a password" />
              </Button>
            </>
          )}
        </div>

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {onLogout ? (
              <FormattedMessage {...common.cancel} />
            ) : (
              <FormattedMessage id="backupKeyDialog.later" defaultMessage="Later" />
            )}
          </Button>
          {onLogout && (
            <Button
              type="button"
              variant={backedUp ? "default" : "destructive"}
              onClick={onLogout}
            >
              {backedUp ? (
                <FormattedMessage id="backupKeyDialog.logOut" defaultMessage="Log out" />
              ) : (
                <FormattedMessage id="backupKeyDialog.logOutAnyway" defaultMessage="Log out anyway" />
              )}
            </Button>
          )}
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
