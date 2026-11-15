import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AlertTriangle, KeyRound, LifeBuoy, Loader2, LockKeyhole, Trash2, UserX } from "lucide-react";
import { nip19 } from "nostr-tools";

import { createAccountClient } from "@/account/client";
import type { AccountStatus } from "@/account/protocol";
import { accountsEnabled, clearAccountSession, markAccountKeyDone, setAccountSession, useAccountState } from "@/account/session";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { APP_NAME } from "@/lib/platform";

import { accountErrorText, MIN_PASSWORD_LENGTH } from "./accountText";
import { RecoveryCodeDialog } from "./RecoveryCodeDialog";

type Action = "store" | "recovery" | "password" | "remove" | "delete";

/**
 * Settings › Account, the email-account half: what the account holds and the
 * few things that can be done to it. Every action asks for the password,
 * because the key that opens the vault is never kept between visits.
 */
export function AccountServerSettings() {
  const intl = useIntl();
  const state = useAccountState();
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const client = useMemo(() => createAccountClient(), []);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const token = state?.token ?? null;
  const enabled = accountsEnabled();

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setStatus(await client.status(token));
    } catch {
      // Offline or an expired session: the rows show what is not known rather than a guess.
      setStatus(null);
    }
  }, [client, token]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, state?.needsKey]);

  if (!enabled || !user || !token) return null;

  const activeLogin = logins[0];
  const localSk = (): string | null => {
    if (activeLogin?.type !== "nsec" || activeLogin.pubkey !== user.pubkey) return null;
    try {
      const decoded = nip19.decode(activeLogin.data.nsec);
      return decoded.type === "nsec" ? bytesToHex(decoded.data) : null;
    } catch {
      return null;
    }
  };

  const open = (next: Action) => {
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setAction(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || busy) return;
    if (action === "password") {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(intl.formatMessage(
          { id: "accountGate.passwordTooShort", defaultMessage: "Use at least {count} characters. A few words in a row is strong and easy to remember." },
          { count: MIN_PASSWORD_LENGTH },
        ));
        return;
      }
      if (newPassword !== confirmPassword) {
        setError(intl.formatMessage({ id: "accountGate.passwordMismatch", defaultMessage: "The two passwords don't match." }));
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const opened = await client.unlock(token, password);
      if (action === "store") {
        const sk = localSk();
        if (!sk) throw new Error("no local key");
        const code = await client.storeKey(opened, { sk });
        await client.linkKey(token, (template) => user.signer.signEvent(template)).catch(() => undefined);
        markAccountKeyDone();
        setRecoveryCode(code);
      } else if (action === "recovery") {
        if (!opened.contents) throw new Error("no stored key");
        setRecoveryCode(await client.storeKey(opened, opened.contents));
      } else if (action === "password") {
        setAccountSession(await client.changePassword(opened, newPassword));
        toast({ title: intl.formatMessage({ id: "accountServerSettings.passwordChanged", defaultMessage: "Password changed. Other devices have been signed out." }) });
      } else if (action === "remove") {
        await client.forgetKey(token);
        toast({ title: intl.formatMessage({ id: "accountServerSettings.keyRemoved", defaultMessage: "Stored key removed. This device still has it." }) });
      } else {
        // Take the key's hash out of the member list too; without a signature it simply stays until it is unlinked.
        await client.linkKey(token, (template) => user.signer.signEvent(template), true).catch(() => undefined);
        await client.deleteAccount(opened);
        clearAccountSession();
      }
      setAction(null);
      void refresh();
    } catch (failure) {
      setError(accountErrorText(intl, failure));
    } finally {
      setBusy(false);
    }
  };

  const copy: Record<Action, { icon: typeof KeyRound; title: string; description: string; submit: string; destructive?: boolean }> = {
    store: {
      icon: LockKeyhole,
      title: intl.formatMessage({ id: "accountServerSettings.storeTitle", defaultMessage: "store your key" }),
      description: intl.formatMessage({ id: "accountServerSettings.storeDescription", defaultMessage: "Your key is locked with your password on this device, then saved to your account. You'll get a recovery code to keep." }),
      submit: intl.formatMessage({ id: "accountServerSettings.storeSubmit", defaultMessage: "Store key" }),
    },
    recovery: {
      icon: LifeBuoy,
      title: intl.formatMessage({ id: "accountServerSettings.recoveryTitle", defaultMessage: "new recovery code" }),
      description: intl.formatMessage({ id: "accountServerSettings.recoveryDescription", defaultMessage: "Makes a new recovery code. The old one stops working straight away." }),
      submit: intl.formatMessage({ id: "accountServerSettings.recoverySubmit", defaultMessage: "Make new code" }),
    },
    password: {
      icon: KeyRound,
      title: intl.formatMessage({ id: "accountServerSettings.passwordTitle", defaultMessage: "change password" }),
      description: intl.formatMessage({ id: "accountServerSettings.passwordDescription", defaultMessage: "Your key is locked again under the new password. Other devices are signed out. Your recovery code stays the same." }),
      submit: intl.formatMessage({ id: "accountServerSettings.passwordSubmit", defaultMessage: "Change password" }),
    },
    remove: {
      icon: Trash2,
      title: intl.formatMessage({ id: "accountServerSettings.removeTitle", defaultMessage: "remove stored key" }),
      description: intl.formatMessage({ id: "accountServerSettings.removeDescription", defaultMessage: "Deletes the locked copy and its recovery code from your account. This device keeps the key, but a new device will need the key itself, not just your email and password." }),
      submit: intl.formatMessage({ id: "accountServerSettings.removeSubmit", defaultMessage: "Remove stored key" }),
      destructive: true,
    },
    delete: {
      icon: UserX,
      title: intl.formatMessage({ id: "accountServerSettings.deleteTitle", defaultMessage: "delete email account" }),
      description: intl.formatMessage(
        { id: "accountServerSettings.deleteDescription", defaultMessage: "Deletes your email account and the locked copy of your key. Your Nostr identity and messages are not touched, and this device keeps the key. {app} will ask you to make an account again or log out." },
        { app: APP_NAME },
      ),
      submit: intl.formatMessage({ id: "accountServerSettings.deleteSubmit", defaultMessage: "Delete email account" }),
      destructive: true,
    },
  };

  const yes = intl.formatMessage({ id: "accountServerSettings.yes", defaultMessage: "Yes" });
  const no = intl.formatMessage({ id: "accountServerSettings.no", defaultMessage: "No" });
  const unknown = "…";
  const current = action ? copy[action] : null;
  const field = "h-11 bg-muted/60 border-transparent clip-corner-lg";

  return (
    <>
      <SettingsGroup
        id="email-account"
        title={intl.formatMessage({ id: "accountServerSettings.title", defaultMessage: "Email account" })}
        footer={intl.formatMessage(
          { id: "accountServerSettings.footer", defaultMessage: "{app} stores a locked copy of your key that only your password opens. It can't see your password, your key, or which key is yours." },
          { app: APP_NAME },
        )}
      >
        {status && !status.hasVault && localSk() ? (
          <SettingsRow
            icon={LockKeyhole}
            tone="warning"
            label={intl.formatMessage({ id: "accountServerSettings.storeRow", defaultMessage: "Store your key in your account" })}
            description={intl.formatMessage({ id: "accountServerSettings.storeRowDescription", defaultMessage: "Not stored yet. Without it, a new device needs the key itself." })}
            chevron
            onClick={() => open("store")}
          />
        ) : (
          <SettingsRow
            icon={LockKeyhole}
            label={intl.formatMessage({ id: "accountServerSettings.keyStored", defaultMessage: "Key stored in your account" })}
            value={status ? (status.hasVault ? yes : no) : unknown}
          />
        )}
        {status?.hasVault && (
          <SettingsRow
            icon={LifeBuoy}
            tone={status.hasRecovery ? undefined : "warning"}
            label={intl.formatMessage({ id: "accountServerSettings.recoveryRow", defaultMessage: "New recovery code" })}
            description={intl.formatMessage({ id: "accountServerSettings.recoveryRowDescription", defaultMessage: "If you've lost the old one, or someone else has seen it." })}
            chevron
            onClick={() => open("recovery")}
          />
        )}
        <SettingsRow
          icon={KeyRound}
          label={intl.formatMessage({ id: "accountServerSettings.passwordRow", defaultMessage: "Change password" })}
          chevron
          onClick={() => open("password")}
        />
        {status?.hasVault && (
          <SettingsRow
            icon={Trash2}
            tone="destructive"
            destructive
            label={intl.formatMessage({ id: "accountServerSettings.removeRow", defaultMessage: "Remove stored key" })}
            onClick={() => open("remove")}
          />
        )}
        <SettingsRow
          icon={UserX}
          tone="destructive"
          destructive
          label={intl.formatMessage({ id: "accountServerSettings.deleteRow", defaultMessage: "Delete email account" })}
          onClick={() => open("delete")}
        />
      </SettingsGroup>

      <Dialog open={action !== null} onOpenChange={(next) => { if (!next && !busy) setAction(null); }}>
        {current && (
          <ChromeDialogContent title={current.title}>
            <ChromeDialogHeader icon={current.icon} tone={current.destructive ? "destructive" : "primary"} title={current.title} description={current.description} />
            <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={intl.formatMessage({ id: "accountServerSettings.currentPassword", defaultMessage: "Your password" })}
                aria-label={intl.formatMessage({ id: "accountServerSettings.currentPassword", defaultMessage: "Your password" })}
                className={field}
                disabled={busy}
              />
              {action === "password" && (
                <>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder={intl.formatMessage({ id: "accountGate.newPassword", defaultMessage: "New password" })}
                    aria-label={intl.formatMessage({ id: "accountGate.newPassword", defaultMessage: "New password" })}
                    className={field}
                    disabled={busy}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder={intl.formatMessage({ id: "accountGate.confirmPassword", defaultMessage: "Password again" })}
                    aria-label={intl.formatMessage({ id: "accountGate.confirmPassword", defaultMessage: "Password again" })}
                    className={field}
                    disabled={busy}
                  />
                </>
              )}
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <ChromeDialogFooter>
                <Button type="button" variant="secondary" className="h-11" onClick={() => setAction(null)} disabled={busy}>
                  <FormattedMessage {...common.cancel} />
                </Button>
                <Button type="submit" variant={current.destructive ? "destructive" : "default"} className="h-11" disabled={busy || !password}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {current.submit}
                </Button>
              </ChromeDialogFooter>
            </form>
          </ChromeDialogContent>
        )}
      </Dialog>

      <RecoveryCodeDialog code={recoveryCode} onDone={() => setRecoveryCode(null)} />
    </>
  );
}
