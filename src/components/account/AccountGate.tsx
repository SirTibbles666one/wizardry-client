import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useNostrLogin } from "@nostrify/react/login";
import { hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey, nip19 } from "nostr-tools";

import { createAccountClient, type OpenedSession } from "@/account/client";
import { normalizeRecoveryCode } from "@/account/crypto";
import { normalizeEmail } from "@/account/protocol";
import { setAccountSession } from "@/account/session";
import { ArmadaKey } from "@/components/brand/ArmadaCrest";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLoginActions } from "@/hooks/useLoginActions";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { APP_NAME } from "@/lib/platform";

import { accountErrorText, MIN_PASSWORD_LENGTH } from "./accountText";
import { RecoveryCodeDialog } from "./RecoveryCodeDialog";

interface AccountGateProps {
  isOpen: boolean;
  /** Absent when the gate may not be dismissed (someone already logged in with a key). */
  onClose?: () => void;
  /** Called once a Nostr login exists because the account's stored key was opened. */
  onLogin: () => void;
  /** Shown under the form when the gate may not be dismissed, e.g. a way to log out. */
  footer?: React.ReactNode;
}

type Step = "signin" | "signup" | "confirm" | "forgot" | "reset";

/**
 * The email-and-password step. It ends in one of two ways: the account holds a
 * key, which is opened on this device and logged in; or it holds none yet, and
 * the caller moves on to choosing one.
 */
export function AccountGate({ isOpen, onClose, onLogin, footer }: AccountGateProps) {
  const intl = useIntl();
  const login = useLoginActions();
  const { logins } = useNostrLogin();
  const client = useMemo(() => createAccountClient(), []);
  const [step, setStep] = useState<Step>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [startOver, setStartOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** A recovery just finished: its new code is shown before the session is used. */
  const [recovered, setRecovered] = useState<{ session: OpenedSession; code: string } | null>(null);

  useEffect(() => {
    if (isOpen) return;
    setStep("signin");
    setPassword("");
    setConfirmPassword("");
    setCode("");
    setRecoveryCode("");
    setStartOver(false);
    setError("");
    setBusy(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const go = (next: Step) => {
    setError("");
    setCode("");
    setStep(next);
  };

  /** Use a session: remember it, and if it carries a key, log that key in here. */
  const adopt = async (session: OpenedSession) => {
    setAccountSession(session);
    if (!session.contents) return;
    const sk = hexToBytes(session.contents.sk);
    // Already logged in with this very key (the gate was shown over a live login): nothing to add.
    if (logins[0]?.pubkey !== getPublicKey(sk)) await login.nsec(nip19.nsecEncode(sk));
    onLogin();
    onClose?.();
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(accountErrorText(intl, failure));
    } finally {
      setBusy(false);
    }
  };

  const checkEmail = (): boolean => {
    if (normalizeEmail(email)) return true;
    setError(intl.formatMessage({ id: "accountGate.badEmail", defaultMessage: "Enter a full email address." }));
    return false;
  };

  const checkNewPassword = (): boolean => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(intl.formatMessage(
        { id: "accountGate.passwordTooShort", defaultMessage: "Use at least {count} characters. A few words in a row is strong and easy to remember." },
        { count: MIN_PASSWORD_LENGTH },
      ));
      return false;
    }
    if (password !== confirmPassword) {
      setError(intl.formatMessage({ id: "accountGate.passwordMismatch", defaultMessage: "The two passwords don't match." }));
      return false;
    }
    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!checkEmail()) return;
    if (step === "signin") {
      void run(async () => adopt(await client.signIn(email, password)));
    } else if (step === "signup") {
      if (!checkNewPassword()) return;
      void run(async () => {
        await client.signUp(email, password);
        go("confirm");
      });
    } else if (step === "confirm") {
      void run(async () => adopt(await client.confirmSignUp(email, password, code)));
    } else if (step === "forgot") {
      void run(async () => {
        await client.startRecovery(email);
        setPassword("");
        setConfirmPassword("");
        go("reset");
      });
    } else {
      if (!checkNewPassword()) return;
      if (startOver) {
        void run(async () => adopt(await client.startOver(email, code, password)));
        return;
      }
      if (!normalizeRecoveryCode(recoveryCode)) {
        setError(intl.formatMessage({ id: "accountGate.badRecoveryCode", defaultMessage: "A recovery code is 20 letters and numbers, like ABCDE-FGHJK-MNPQR-STVWX." }));
        return;
      }
      void run(async () => {
        const result = await client.recover(email, code, recoveryCode, password);
        setRecovered({ session: result.session, code: result.recoveryCode });
      });
    }
  };

  const titles: Record<Step, string> = {
    signin: intl.formatMessage({ id: "accountGate.signInTitle", defaultMessage: "sign in" }),
    signup: intl.formatMessage({ id: "accountGate.signUpTitle", defaultMessage: "create your account" }),
    confirm: intl.formatMessage({ id: "accountGate.confirmTitle", defaultMessage: "check your email" }),
    forgot: intl.formatMessage({ id: "accountGate.forgotTitle", defaultMessage: "forgot your password" }),
    reset: intl.formatMessage({ id: "accountGate.resetTitle", defaultMessage: "set a new password" }),
  };

  const descriptions: Record<Step, string> = {
    signin: intl.formatMessage({ id: "accountGate.signInDescription", defaultMessage: "Your email and password unlock your key on this device." }),
    signup: intl.formatMessage(
      { id: "accountGate.signUpDescription", defaultMessage: "{app} never sees your password, and can't tell which key belongs to your email." },
      { app: APP_NAME },
    ),
    confirm: intl.formatMessage({ id: "accountGate.confirmDescription", defaultMessage: "We sent a six-digit code to {email}. It works for 15 minutes." }, { email: email.trim() }),
    forgot: intl.formatMessage({ id: "accountGate.forgotDescription", defaultMessage: "We'll email you a code. You'll also need the recovery code you saved when you made your account." }),
    reset: intl.formatMessage({ id: "accountGate.resetDescription", defaultMessage: "Enter the code from your email, your recovery code, and a new password." }),
  };

  const submitLabel: Record<Step, string> = {
    signin: intl.formatMessage({ id: "accountGate.signIn", defaultMessage: "Sign in" }),
    signup: intl.formatMessage({ id: "accountGate.createAccount", defaultMessage: "Create account" }),
    confirm: intl.formatMessage({ id: "accountGate.confirm", defaultMessage: "Confirm" }),
    forgot: intl.formatMessage({ id: "accountGate.sendCode", defaultMessage: "Email me a code" }),
    reset: startOver
      ? intl.formatMessage({ id: "accountGate.startOverSubmit", defaultMessage: "Start over with a new key" })
      : intl.formatMessage({ id: "accountGate.resetSubmit", defaultMessage: "Set password" }),
  };

  const field = "h-12 bg-muted/60 border-transparent clip-corner-lg";
  const linkClass = "text-sm font-medium text-primary underline-offset-4 hover:underline touch:py-2";
  const showEmail = step === "signin" || step === "signup" || step === "forgot";
  const showPassword = step === "signin" || step === "signup" || step === "reset";
  const newPassword = step === "signup" || step === "reset";
  const showCode = step === "confirm" || step === "reset";

  return createPortal(
    <WizardShell index={0} total={0} stepKey={step} zClassName="z-[255]" onClose={onClose}>
      <div className="flex flex-col items-center gap-8 text-center">
        <ArmadaKey size={110} />
        <div className="space-y-2.5">
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">{titles[step]}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{descriptions[step]}</p>
        </div>

        <form onSubmit={submit} className="w-full space-y-3 text-left" noValidate>
          {showEmail && (
            <Input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={intl.formatMessage({ id: "accountGate.email", defaultMessage: "Email" })}
              aria-label={intl.formatMessage({ id: "accountGate.email", defaultMessage: "Email" })}
              className={field}
              disabled={busy}
            />
          )}
          {showCode && (
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              placeholder={intl.formatMessage({ id: "accountGate.emailCode", defaultMessage: "Code from your email" })}
              aria-label={intl.formatMessage({ id: "accountGate.emailCode", defaultMessage: "Code from your email" })}
              className={`${field} text-center font-mono text-lg tracking-[0.3em]`}
              disabled={busy}
            />
          )}
          {step === "reset" && !startOver && (
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              placeholder={intl.formatMessage({ id: "accountGate.recoveryCode", defaultMessage: "Recovery code" })}
              aria-label={intl.formatMessage({ id: "accountGate.recoveryCode", defaultMessage: "Recovery code" })}
              className={`${field} font-mono`}
              disabled={busy}
            />
          )}
          {showPassword && (
            <Input
              type="password"
              autoComplete={newPassword ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={newPassword
                ? intl.formatMessage({ id: "accountGate.newPassword", defaultMessage: "New password" })
                : intl.formatMessage({ id: "accountGate.password", defaultMessage: "Password" })}
              aria-label={newPassword
                ? intl.formatMessage({ id: "accountGate.newPassword", defaultMessage: "New password" })
                : intl.formatMessage({ id: "accountGate.password", defaultMessage: "Password" })}
              className={field}
              disabled={busy}
            />
          )}
          {newPassword && (
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
          )}

          {step === "reset" && startOver && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <FormattedMessage
                  id="accountGate.startOverWarning"
                  defaultMessage="Without your recovery code we can't get your key back. Starting over keeps your email and gives you a new, empty identity. Your old one is lost for good."
                />
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" className="h-12 w-full clip-corner-lg text-base font-medium" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {submitLabel[step]}
          </Button>
        </form>

        <div className="flex flex-col items-center gap-1">
          {step === "signin" && (
            <>
              <button type="button" className={linkClass} onClick={() => go("signup")}>
                <FormattedMessage id="accountGate.toSignUp" defaultMessage="New here? Create an account" />
              </button>
              <button type="button" className={linkClass} onClick={() => go("forgot")}>
                <FormattedMessage id="accountGate.toForgot" defaultMessage="Forgot password" />
              </button>
            </>
          )}
          {step === "signup" && (
            <button type="button" className={linkClass} onClick={() => go("signin")}>
              <FormattedMessage id="accountGate.toSignIn" defaultMessage="Already have an account? Sign in" />
            </button>
          )}
          {step === "confirm" && (
            <button type="button" className={linkClass} onClick={() => go("signup")}>
              <FormattedMessage id="accountGate.changeEmail" defaultMessage="Use a different email" />
            </button>
          )}
          {step === "reset" && (
            <button type="button" className={linkClass} onClick={() => { setError(""); setStartOver((value) => !value); }}>
              {startOver
                ? <FormattedMessage id="accountGate.haveRecoveryCode" defaultMessage="I have my recovery code" />
                : <FormattedMessage id="accountGate.lostRecoveryCode" defaultMessage="I've lost my recovery code" />}
            </button>
          )}
          {(step === "forgot" || step === "reset") && (
            <button type="button" className={linkClass} onClick={() => go("signin")}>
              <FormattedMessage {...common.back} />
            </button>
          )}
          {footer}
        </div>
      </div>

      <RecoveryCodeDialog
        code={recovered?.code ?? null}
        onDone={() => {
          const session = recovered?.session;
          setRecovered(null);
          if (session) void run(async () => adopt(session));
        }}
      />
    </WizardShell>,
    document.body,
  );
}
