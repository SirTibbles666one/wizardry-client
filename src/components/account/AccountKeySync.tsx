import { useEffect, useMemo, useRef, useState } from "react";
import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";

import { createAccountClient } from "@/account/client";
import {
  accountReady,
  accountsEnabled,
  clearAccountSession,
  getAccountState,
  markAccountKeyDone,
  useAccountState,
} from "@/account/session";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useLoggedInAccounts } from "@/hooks/useLoggedInAccounts";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, useIntl } from "@/i18n";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";

import { AccountGate } from "./AccountGate";
import { accountErrorText } from "./accountText";
import { RecoveryCodeDialog } from "./RecoveryCodeDialog";

/**
 * Signed-in half of accounts. With an account server configured:
 *
 * - someone logged in with a key but no account is asked for one, and cannot
 *   dismiss the question (they can log out instead);
 * - a fresh account that owes a key gets the key now in use: an nsec is locked
 *   into the vault and its recovery code shown, and any kind of key is linked
 *   by a signed proof so the server knows it is a member's;
 * - the last logout ends the server session as well.
 */
export function AccountKeySync() {
  const intl = useIntl();
  const state = useAccountState();
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const { removeLogin, currentUser } = useLoggedInAccounts();
  const client = useMemo(() => createAccountClient(), []);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const working = useRef(false);
  const enabled = accountsEnabled();

  useEffect(() => {
    if (!enabled) return undefined;
    return registerBeforeAccountExit(async (reason) => {
      if (reason !== "final-logout") return;
      const token = getAccountState()?.token;
      clearAccountSession();
      // Best-effort: the token dies on its own in 30 days, and logout must not wait on a server.
      if (token) await client.signOut(token).catch(() => undefined);
    });
  }, [client, enabled]);

  const activeLogin = logins[0];
  const pubkey = user?.pubkey;
  const signer = user?.signer;
  const unlocked = state?.unlocked ?? null;
  const owesKey = enabled && state?.needsKey === true && unlocked !== null;

  useEffect(() => {
    if (!owesKey || !unlocked || !pubkey || !signer || working.current) return;
    working.current = true;
    void (async () => {
      try {
        if (activeLogin?.type === "nsec" && activeLogin.pubkey === pubkey) {
          const decoded = nip19.decode(activeLogin.data.nsec);
          if (decoded.type !== "nsec") throw new Error("bad login");
          setRecoveryCode(await client.storeKey(unlocked, { sk: bytesToHex(decoded.data) }));
        }
        await client.linkKey(unlocked.token, (template) => signer.signEvent(template));
        markAccountKeyDone();
      } catch (failure) {
        toast({
          title: intl.formatMessage({ id: "accountKeySync.failed", defaultMessage: "Your key isn't saved to your account yet" }),
          description: accountErrorText(intl, failure),
          variant: "destructive",
        });
      } finally {
        working.current = false;
      }
    })();
  }, [activeLogin, client, intl, owesKey, pubkey, signer, unlocked]);

  if (!enabled) return null;

  return (
    <>
      {!accountReady(state) && recoveryCode === null && (
        <AccountGate
          isOpen
          onLogin={() => undefined}
          footer={currentUser && (
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline touch:py-2"
              onClick={() => void removeLogin(currentUser.id)}
            >
              <FormattedMessage id="accountKeySync.logOutInstead" defaultMessage="Log out instead" />
            </button>
          )}
        />
      )}
      <RecoveryCodeDialog code={recoveryCode} onDone={() => setRecoveryCode(null)} />
    </>
  );
}
