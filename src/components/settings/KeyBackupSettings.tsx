import { Capacitor } from "@capacitor/core";
import { Check, Copy, Download, Eye, EyeOff, Lock, Share2, ShieldAlert } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import { saveNsec, exportNcryptsec } from "@/lib/credentialManager";
import { desktopSecretsStatus, isDesktop } from "@/lib/desktop";
import { clearKeyBackupPending } from "@/lib/keyBackup";
import { encryptNsecToNcryptsec, keySecurityFor } from "@/lib/nip49";
import { share } from "@/lib/share";
import { keyStorageTier } from "@/lib/secureStorage";

import type { SecretsStatus } from "@/lib/desktop";

/**
 * Desktop key-at-rest storage. `basic_text` is Chromium's no-keyring
 * fallback (obfuscated, not encrypted); say so rather than claim protection.
 */
function KeyStorageRow() {
  const intl = useIntl();
  const [status, setStatus] = useState<SecretsStatus | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    desktopSecretsStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isDesktop() || !status) return null;

  const encrypted = status.available && status.backend !== "basic_text";

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "keyBackupSettings.storage", defaultMessage: "Storage on this device" })}
      description={
        encrypted
          ? intl.formatMessage({ id: "keyBackupSettings.storageEncrypted", defaultMessage: "Encrypted by your system's credential store." })
          : status.available
            ? intl.formatMessage({ id: "keyBackupSettings.storageObfuscated", defaultMessage: "Only obfuscated on disk." })
            : intl.formatMessage({ id: "keyBackupSettings.storageUnencrypted", defaultMessage: "Stored unencrypted on this device." })
      }
      info={
        !encrypted && status.available
          ? intl.formatMessage({ id: "keyBackupSettings.storageInfo", defaultMessage: "No system keyring was found, so your key is only obfuscated on disk. Installing a keyring (GNOME Keyring or KWallet) enables real encryption." })
          : undefined
      }
    >
      {encrypted ? (
        <Lock className="size-4 text-success" aria-label={intl.formatMessage({ id: "keyBackupSettings.encrypted", defaultMessage: "Encrypted" })} />
      ) : (
        <ShieldAlert className="size-4 text-warning" aria-label={intl.formatMessage({ id: "keyBackupSettings.notEncrypted", defaultMessage: "Not encrypted" })} />
      )}
    </SettingsRow>
  );
}

interface KeyBackupSettingsProps {
  nsec: string;
  pubkey: string;
}

/** Same floor the backup dialog uses for a NIP-49 password. */
const MIN_PASSWORD_LENGTH = 8;

/** Reveal/copy/download the secret key. Only rendered for nsec logins. */
export function KeyBackupSettings({ nsec, pubkey }: KeyBackupSettingsProps) {
  const intl = useIntl();
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<"nsec" | "npub" | null>(null);
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [encrypting, setEncrypting] = useState(false);
  const npub = nip19.npubEncode(pubkey);

  const copy = async (text: string, which: "nsec" | "npub") => {
    try {
      await writeClipboardText(text);
      setCopied(which);
      if (which === "nsec") clearKeyBackupPending(pubkey);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast({
        title: t({ id: "keyBackupSettings.copyFailed", defaultMessage: "Copy failed" }),
        description: t({ id: "keyBackupSettings.copyFailedDescription", defaultMessage: "Could not copy to the clipboard. Please select and copy it manually." }),
        variant: "destructive",
      });
    }
  };

  // Native WebViews can't do blob downloads, so use the share sheet.
  const backup = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        await share({
          title: t({ id: "keyBackupSettings.shareTitle", defaultMessage: "Wizardry secret key" }),
          text: nsec,
          dialogTitle: t({ id: "keyBackupSettings.shareDialogTitle", defaultMessage: "Back up your secret key" }),
        });
      } else {
        await saveNsec(npub, nsec);
      }
      // Neither path reports a cancel; a deliberate backup from here counts.
      clearKeyBackupPending(pubkey);
    } catch {
      toast({
        title: t({ id: "keyBackupSettings.backupFailed", defaultMessage: "Backup failed" }),
        description: t({ id: "keyBackupSettings.backupFailedDescription", defaultMessage: "Could not save the key. Please copy it manually." }),
        variant: "destructive",
      });
    }
  };

  /**
   * NIP-49: the key leaves this device already encrypted, so the saved file (or
   * the shared text on a phone) is worthless to whoever finds it.
   */
  const backUpEncrypted = async () => {
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
      const ncryptsec = await encryptNsecToNcryptsec(nsec, password, { keySecurity });

      if (Capacitor.isNativePlatform()) {
        await share({
          title: t({ id: "keyBackupSettings.shareTitleEncrypted", defaultMessage: "Wizardry encrypted key" }),
          text: ncryptsec,
          dialogTitle: t({
            id: "keyBackupSettings.shareDialogTitleEncrypted",
            defaultMessage: "Back up your encrypted key",
          }),
        });
        toast({
          title: t({ id: "backupKeyDialog.encryptedSaved.title", defaultMessage: "Encrypted key saved" }),
        });
      } else {
        const result = await exportNcryptsec(ncryptsec);
        if (result.status === "cancelled") return;
        if (result.status === "failed") {
          toast({
            title: t({ id: "keyBackupSettings.backupFailed", defaultMessage: "Backup failed" }),
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
      }

      setPassword("");
      setConfirmation("");
      setEncryptOpen(false);
      // An encrypted backup is a backup: the reminder stops asking.
      clearKeyBackupPending(pubkey);
    } catch {
      toast({
        title: t({ id: "keyBackupSettings.backupFailed", defaultMessage: "Backup failed" }),
        description: t({ id: "backupKeyDialog.encryptFailed", defaultMessage: "Couldn't encrypt this key. Try again." }),
        variant: "destructive",
      });
    } finally {
      setEncrypting(false);
    }
  };

  return (
    <>
      <SettingsRow>
        <div className="clip-corner-lg bg-warning/10 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-warning">
              <FormattedMessage id="keyBackupSettings.warningTitle" defaultMessage="Keep this key secret" />
            </span>
          </div>
          <p className="text-xs text-warning">
            <FormattedMessage
              id="keyBackupSettings.warning"
              defaultMessage="It's the only way into your account, with no reset, and anyone who sees it controls your identity. Keep it in a password manager."
            />
          </p>
        </div>
      </SettingsRow>

      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium leading-tight">
            <FormattedMessage id="keyBackupSettings.secretKey" defaultMessage="Secret key" />
          </div>
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              value={nsec}
              readOnly
              className="pr-10 font-mono bg-background/40 border-transparent"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey
                ? intl.formatMessage({ id: "keyBackupSettings.hideKey", defaultMessage: "Hide secret key" })
                : intl.formatMessage({ id: "keyBackupSettings.revealKey", defaultMessage: "Reveal secret key" })}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 clip-corner-lg"
              onClick={() => copy(nsec, "nsec")}
            >
              {copied === "nsec" ? (
                <Check className="size-4 text-success" />
              ) : (
                <Copy className="size-4" />
              )}
              <FormattedMessage {...common.copy} />
            </Button>
            <Button variant="secondary" className="flex-1 clip-corner-lg" onClick={backup}>
              {Capacitor.isNativePlatform() ? (
                <Share2 className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              <FormattedMessage id="keyBackupSettings.backUp" defaultMessage="Back up" />
            </Button>
          </div>

          {/* NIP-49: hand the key over encrypted, so a copied file is worthless. */}
          <Button
            variant="secondary"
            className="w-full clip-corner-lg"
            onClick={() => setEncryptOpen((open) => !open)}
            aria-expanded={encryptOpen}
          >
            <Lock className="size-4" />
            <FormattedMessage id="backupKeyDialog.encryptWithPassword" defaultMessage="Back up with a password" />
          </Button>

          {encryptOpen && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-muted-foreground">
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
                className="bg-background/40 border-transparent"
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
                    void backUpEncrypted();
                  }
                }}
                className="bg-background/40 border-transparent"
              />
              {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
              <Button
                className="w-full clip-corner-lg"
                onClick={backUpEncrypted}
                disabled={encrypting || !password || !confirmation}
              >
                <Lock className="size-4" />
                {encrypting ? (
                  <FormattedMessage id="backupKeyDialog.encrypting" defaultMessage="Encrypting…" />
                ) : (
                  <FormattedMessage id="backupKeyDialog.encryptKey" defaultMessage="Encrypt key" />
                )}
              </Button>
            </div>
          )}
        </div>
      </SettingsRow>

      <KeyStorageRow />

      <SettingsRow
        label={intl.formatMessage({ id: "keyBackupSettings.publicKey", defaultMessage: "Public key" })}
        description={intl.formatMessage({ id: "keyBackupSettings.publicKeyDescription", defaultMessage: "Your public identity, safe to share with anyone." })}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-9 touch:size-11"
          onClick={() => copy(npub, "npub")}
          aria-label={intl.formatMessage({ id: "keyBackupSettings.copyPublicKey", defaultMessage: "Copy public key" })}
        >
          {copied === "npub" ? (
            <Check className="size-4 text-success" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </SettingsRow>
    </>
  );
}
