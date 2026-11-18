// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronDown, Copy, ExternalLink, FileUp, Loader2, Lock, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArmadaKey } from '@/components/brand/ArmadaCrest';
import { SignupTerms } from '@/components/onboarding/SignupTerms';
import { WizardShell } from '@/components/onboarding/WizardShell';
import { TermsGate } from '@/components/onboarding/TermsGate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import {
  useLoginActions,
  generateNostrConnectParams,
  generateNostrConnectURI,
  type NostrConnectParams,
  type NostrConnectStatus,
} from '@/hooks/useLoginActions';
import { AndroidSignerOptions } from '@/components/auth/AndroidSignerOptions';
import { getNsecCredential } from '@/lib/credentialManager';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { APP_NAME } from '@/lib/platform';
import { shareOrigin } from '@/lib/shareOrigin';
import { withConnectPerms } from "@/lib/nostrConnectPerms";
import { toast } from '@/hooks/useToast';
import { writeClipboardText } from '@/lib/clipboard';
import { common, FormattedMessage, t, useIntl, type IntlShape } from '@/i18n';
import { accountReady, accountsEnabled, skipAccountGate, useAccountState, useKeyInstead } from '@/account/session';
import { AccountGate } from '@/components/account/AccountGate';
import { decryptNcryptsecToNsec, isNcryptsec, NcryptsecError, readNcryptsec } from '@/lib/nip49';

interface LoginScreenProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignupClick?: () => void;
  /** True when the person got here through an account, so its key is what is being chosen. */
  accountExists?: boolean;
}

// bech32 charset (no b, i, o, 1 or uppercase), so a mistyped key fails here.
const validateNsec = (nsec: string) => {
  return /^nsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(nsec);
};

// Input starting with nsec1 is almost always a truncated paste; say so.
const nsecRejectionMessage = (input: string) => {
  if (input.startsWith('ncryptsec1')) {
    return t({ id: "loginScreen.incompleteNcryptsec", defaultMessage: "That doesn't look like a complete encrypted key. Check you copied the whole ncryptsec1… value." });
  }
  return input.startsWith('nsec1')
    ? t({ id: "loginScreen.incompleteNsec", defaultMessage: "That doesn't look like a complete secret key. Check you copied the whole nsec." })
    : t({ id: "loginScreen.enterKey", defaultMessage: "Enter a secret key starting with nsec1, an encrypted key starting with ncryptsec1, or a bunker:// URI." });
};

// A phone's browser is backgrounded while the signer runs, and it has a callback
// to return through. Decided by device, not width: a narrow desktop window with no
// handler for the scheme still needs the QR and its link left up.
const isMobileDevice = () =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const validateBunkerUri = (uri: string) => {
  return uri.startsWith('bunker://');
};

const connectStatusLabel = (intl: IntlShape, status: NostrConnectStatus | null): string => {
  switch (status) {
    case 'awaiting-connect':
      return intl.formatMessage({ id: "loginScreen.awaitingConnect", defaultMessage: "Waiting for signer connection…" });
    case 'getting-public-key':
      return intl.formatMessage({ id: "loginScreen.gettingPublicKey", defaultMessage: "Getting public key…" });
    default:
      return '';
  }
};

/**
 * Full-screen login in the signup wizard's chrome ({@link WizardShell}). With
 * `onSignupClick` (opened from "Join"), "Create account" is the primary action
 * and login methods sit under an "or log in" divider. One smart input takes an
 * nsec or bunker:// URI. Driven by `isOpen` (not conditionally mounted) so the
 * handshake effects can abort cleanly on close.
 */
const KeyLoginScreen: React.FC<LoginScreenProps> = ({ isOpen, onClose, onLogin, onSignupClick, accountExists }) => {
  // On the APK the WebView origin is unreachable from the signer's browser, so
  // use the public deployment; its verified App Link reopens the app (#44).
  const callbackOrigin = shareOrigin();
  const intl = useIntl();
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');
  // NIP-49: an `ncryptsec1…` pasted above needs its password before it is a key.
  const [backupPassword, setBackupPassword] = useState('');
  // The pasted value is a usable password-encrypted key, so ask for its password.
  const encryptedBackup = isNcryptsec(loginInput);
  const backupHeader = encryptedBackup ? readNcryptsec(loginInput) : null;
  const [extensionError, setExtensionError] = useState('');
  const [nostrConnectParams, setNostrConnectParams] = useState<NostrConnectParams | null>(null);
  const [nostrConnectUri, setNostrConnectUri] = useState<string>('');
  const [connectError, setConnectError] = useState<string | null>(null);
  // Handshake progress; `null` until the user starts it (or after cancel/retry).
  const [connectStatus, setConnectStatus] = useState<NostrConnectStatus | null>(null);
  // Mobile only: the subscription listens as soon as params exist, so don't show
  // progress until the user tapped "Open signer app".
  const [hasOpenedSigner, setHasOpenedSigner] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copiedConnectUri, setCopiedConnectUri] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const login = useLoginActions();
  const { currentUser } = useLoggedInAccounts();

  // Stable refs so parents' inline callbacks don't re-run the listening effect.
  const onLoginRef = useRef(onLogin);
  const onCloseRef = useRef(onClose);
  const loginRef = useRef(login);
  useEffect(() => { onLoginRef.current = onLogin; }, [onLogin]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { loginRef.current = login; }, [login]);

  const [isMobile] = useState(isMobileDevice);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const hasExtension = 'nostr' in window;

  // Returns the URI so the mobile deeplink can use it immediately.
  const generateConnectSession = useCallback((): string => {
    const relayUrls = login.getRelayUrls();
    const params = generateNostrConnectParams(relayUrls);
    const uri = withConnectPerms(generateNostrConnectURI(params, {
      name: APP_NAME,
      callback: isMobile ? `${callbackOrigin}/remoteloginsuccess` : undefined,
    }));
    setNostrConnectParams(params);
    setNostrConnectUri(uri);
    setConnectError(null);
    return uri;
  }, [login, callbackOrigin, isMobile]);

  // Deps limited to `nostrConnectParams`: re-running on parent renders would
  // cancel an in-flight subscription and swallow the signer's approval.
  useEffect(() => {
    if (!nostrConnectParams) return;

    const startListening = async () => {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        await loginRef.current.nostrconnect(
          nostrConnectParams,
          controller.signal,
          (status) => {
            if (controller.signal.aborted) return;
            setConnectStatus(status);
          },
        );
        // Already aborted by the isOpen effect: don't re-close.
        if (controller.signal.aborted) return;
        onLoginRef.current();
        onCloseRef.current();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (controller.signal.aborted) return;
        console.error('Nostrconnect failed:', error);
        setConnectStatus(null);
        setConnectError(error instanceof Error ? error.message : String(error));
      }
    };

    startListening();

    // No cleanup on purpose; cancellation is explicit (isOpen effect, handleConnectCancel).
  }, [nostrConnectParams]);

  useEffect(() => {
    if (!isOpen) {
      setLoginInput('');
      setLoginError('');
      setExtensionError('');
      setNostrConnectParams(null);
      setNostrConnectUri('');
      setConnectError(null);
      setConnectStatus(null);
      setHasOpenedSigner(false);
      setShowQr(false);
      setCopiedConnectUri(false);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
  }, [isOpen]);

  const handleConnectCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setNostrConnectParams(null);
    setNostrConnectUri('');
    setConnectError(null);
    setConnectStatus(null);
    setHasOpenedSigner(false);
    setShowQr(false);
    setCopiedConnectUri(false);
  }, []);

  const handleShowQr = () => {
    if (!nostrConnectParams) generateConnectSession();
    setShowQr(true);
  };

  // Hands the pairing link to a signer app. Flip into the progress view
  // *synchronously* so it's showing when the user returns. On desktop the app may
  // never launch (no handler for the scheme), so leave the QR and its link up as
  // the fallback instead of an inert form.
  const handleOpenSignerApp = () => {
    const uri = nostrConnectUri || generateConnectSession();
    setHasOpenedSigner(true);
    if (!isMobile) setShowQr(true);
    window.location.href = uri;
  };

  // A signer on this same device has no camera to scan the QR with, so the link
  // has to be pasteable. The field stays visible and selectable for a browser
  // that refuses the clipboard API (a plain-http self-host is not a secure
  // context), which is why the copy is not the only way to get the text.
  const copyConnectUri = async () => {
    try {
      await writeClipboardText(nostrConnectUri);
      setCopiedConnectUri(true);
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedConnectUri(false), 2000);
      toast({
        title: t({ id: "loginScreen.linkCopied", defaultMessage: "Link copied" }),
        description: t({ id: "loginScreen.linkCopiedDescription", defaultMessage: "Paste it into your signer app." }),
      });
    } catch {
      toast({
        title: t({ id: "loginScreen.copyFailed", defaultMessage: "Copy failed" }),
        description: t({ id: "loginScreen.copyFailedDescription", defaultMessage: "Could not copy to the clipboard. Select the link and copy it manually." }),
        variant: 'destructive',
      });
    }
  };

  const handleExtensionLogin = async () => {
    setIsLoading(true);
    setExtensionError('');

    try {
      if (!('nostr' in window)) {
        throw new Error(t({ id: "loginScreen.extensionMissing", defaultMessage: "Nostr extension not found. Please install a NIP-07 extension." }));
      }
      await login.extension();
      onLogin();
      onClose();
    } catch (e: unknown) {
      const error = e as Error;
      console.error('Extension login failed:', error);
      setExtensionError(error instanceof Error ? error.message : t({ id: "loginScreen.extensionFailed", defaultMessage: "Extension login failed" }));
    } finally {
      setIsLoading(false);
    }
  };

  const executeLogin = (key: string) => {
    setIsLoading(true);
    setLoginError('');

    // Let the UI update before the synchronous login call.
    setTimeout(async () => {
      try {
        await login.nsec(key);
        onLogin();
        onClose();
      } catch {
        setLoginError(t({ id: "loginScreen.nsecFailed", defaultMessage: "Failed to login with this key. Please check that it's correct." }));
        setIsLoading(false);
      }
    }, 50);
  };

  /**
   * NIP-49: a password-encrypted key is decrypted here, in the page, and never
   * leaves it — the result is the same nsec a paste would have given, so the
   * rest of the login (and what is stored) is unchanged.
   */
  const unlockEncryptedKey = async (ncryptsec: string) => {
    if (!backupPassword) {
      setLoginError(t({ id: "loginScreen.ncryptsecNeedsPassword", defaultMessage: "This key is encrypted. Enter the password you set when you exported it." }));
      return;
    }

    setIsLoading(true);
    setLoginError('');
    try {
      const nsec = await decryptNcryptsecToNsec(ncryptsec, backupPassword);
      setBackupPassword('');
      try {
        await login.nsec(nsec);
      } catch {
        setLoginError(t({ id: "loginScreen.nsecFailed", defaultMessage: "Failed to login with this key. Please check that it's correct." }));
        return;
      }
      setLoginInput('');
      onLogin();
      onClose();
    } catch (error) {
      setLoginError(
        error instanceof NcryptsecError && /wrong password/i.test(error.message)
          ? t({ id: "loginScreen.ncryptsecWrongPassword", defaultMessage: "Wrong password for this backup. Check it and try again." })
          : t({ id: "loginScreen.ncryptsecFailed", defaultMessage: "Couldn't unlock this backup. Check the password, or that you pasted the whole key." }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  // An nsec logs in locally; an ncryptsec is decrypted here first; a
  // bunker:// URI connects a NIP-46 signer.
  const handleLogin = async () => {
    const input = loginInput.trim();
    if (!input) {
      setLoginError(t({ id: "loginScreen.enterKeyOrBunker", defaultMessage: "Please enter your secret key or bunker URI" }));
      return;
    }

    if (validateBunkerUri(input)) {
      setIsLoading(true);
      setLoginError('');
      try {
        await login.bunker(input);
        onLogin();
        onClose();
        // Clear the URI from memory
        setLoginInput('');
      } catch {
        setLoginError(t({ id: "loginScreen.bunkerFailed", defaultMessage: "Failed to connect. Check the bunker URI." }));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (isNcryptsec(input)) {
      await unlockEncryptedKey(input);
      return;
    }

    if (!validateNsec(input)) {
      setLoginError(nsecRejectionMessage(input));
      return;
    }
    executeLogin(input);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setLoginError('');

    const reader = new FileReader();
    reader.onload = (event) => {
      setIsFileLoading(false);
      const content = event.target?.result as string;
      const trimmedContent = content?.trim();
      if (trimmedContent && validateNsec(trimmedContent)) {
        executeLogin(trimmedContent);
      } else if (trimmedContent && isNcryptsec(trimmedContent)) {
        // A NIP-49 backup file: hand it to the form, which asks for its password.
        setLoginInput(trimmedContent);
      } else if (trimmedContent) {
        setLoginError(t({ id: "loginScreen.fileInvalid", defaultMessage: "File does not contain a valid secret key." }));
      } else {
        setLoginError(t({ id: "loginScreen.fileUnreadable", defaultMessage: "Could not read file content." }));
      }
    };
    reader.onerror = () => {
      setIsFileLoading(false);
      setLoginError(t({ id: "loginScreen.fileReadFailed", defaultMessage: "Failed to read file." }));
    };
    reader.readAsText(file);
  };

  // Web Credential Management API: Chromium (incl. Android WebView via Google
  // Password Manager) only; inert on WebKit. Skipped when signed in: in "Add
  // another account" `mediation: "optional"` would silently re-log the same account.
  useEffect(() => {
    if (!isOpen || currentUser) return;
    let cancelled = false;

    getNsecCredential().then((cred) => {
      if (cancelled || !cred) return;
      if (validateNsec(cred.nsec)) {
        executeLogin(cred.nsec);
      }
    });

    return () => { cancelled = true; };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile: show progress once "Open signer app" was tapped. Desktop: keep the
  // QR (still scannable) until the signer acknowledges.
  const showProgressView = connectStatus !== null && (
    connectStatus === 'getting-public-key' ||
    (isMobile && hasOpenedSigner)
  );

  if (!isOpen) return null;

  // Doubles as the shell's step key so view changes replay the enter animation.
  const view = connectError ? 'error' : showProgressView ? 'progress' : showQr ? 'qr' : 'form';

  // From "Join", creating an account is primary; from "Add another account"
  // there's nothing to create. Form view only.
  const joinMode = !!onSignupClick && view === 'form';

  return createPortal(
    // `total={0}` drops the progress bar. z-[255] clears Radix dialogs (z-[250])
    // but stays under dropdown content (z-[260]).
    // Portalled to <body>: a transformed ancestor (SwipeReveal) would otherwise
    // become the containing block for `position: fixed` and clip the takeover.
    <WizardShell index={0} total={0} stepKey={view} zClassName="z-[255]" onClose={onClose}>
      <TermsGate>
      <div className="flex flex-col items-center gap-8 text-center">
        <ArmadaKey size={110} />

        <div className="space-y-2.5">
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
            {joinMode ? (
              <FormattedMessage id="loginScreen.joinTitle" defaultMessage="join {app}" values={{ app: APP_NAME.toLowerCase() }} />
            ) : (
              <FormattedMessage id="loginScreen.logInTitle" defaultMessage="log in" />
            )}
          </h1>
          {joinMode && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {accountsEnabled() && accountExists ? (
                <FormattedMessage id="loginScreen.chooseKeyDescription" defaultMessage="You're signed in. Now choose your key: make a new one, or use one you already have. It will be locked to your account." />
              ) : accountsEnabled() ? (
                <FormattedMessage id="loginScreen.keyOnlyDescription" defaultMessage="Make a new key, or log in with one you already have." />
              ) : (
                <FormattedMessage id="loginScreen.joinDescription" defaultMessage="Create a new account, or log in with a key you already have." />
              )}
            </p>
          )}
        </div>

        <div className='w-full space-y-4 text-left'>
          {connectError ? (
            <div className='flex flex-col items-center space-y-3 py-4'>
              <p className='text-sm text-destructive text-center'>{connectError}</p>
              <Button variant='outline' onClick={handleConnectCancel} className='clip-corner-lg'>
                <FormattedMessage {...common.tryAgain} />
              </Button>
            </div>
          ) : showProgressView ? (
            <div className='flex flex-col items-center space-y-4 py-6 w-full'>
              <Loader2 className='w-8 h-8 animate-spin text-primary' />
              <p className='text-sm text-muted-foreground text-center min-h-[1.25rem]'>
                {connectStatusLabel(intl, connectStatus) || intl.formatMessage({ id: "loginScreen.waitingForSigner", defaultMessage: "Waiting for your signer…" })}
              </p>
              <button
                type='button'
                onClick={handleConnectCancel}
                className='text-sm text-primary hover:underline underline-offset-4 font-medium'
              >
                <FormattedMessage {...common.cancel} />
              </button>
            </div>
          ) : showQr ? (
            <div className='flex flex-col items-center space-y-4'>
              {nostrConnectUri ? (
                <div className='p-4 bg-white dark:bg-white clip-corner-lg'>
                  <QRCodeCanvas value={nostrConnectUri} size={180} level='M' />
                </div>
              ) : (
                <div className='flex items-center justify-center h-[180px]'>
                  <Loader2 className='w-8 h-8 animate-spin text-muted-foreground' />
                </div>
              )}
              <p className='text-sm text-muted-foreground text-center'>
                <FormattedMessage id="loginScreen.scanQr" defaultMessage="Scan with a signer app to log in, or copy the link if your signer is on this device." />
              </p>
              {nostrConnectUri && (
                <div className='relative w-full'>
                  <Input
                    readOnly
                    value={nostrConnectUri}
                    aria-label={intl.formatMessage({ id: "loginScreen.connectLink", defaultMessage: "Signer connect link" })}
                    className='pr-12 font-mono text-xs'
                  />
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    className='absolute right-0 top-0 h-full w-10 touch:w-11 clip-corner-lg text-muted-foreground hover:bg-muted/60'
                    onClick={copyConnectUri}
                    aria-label={copiedConnectUri ? intl.formatMessage({ id: "loginScreen.linkCopied", defaultMessage: "Link copied" }) : intl.formatMessage(common.copyLink)}
                    title={copiedConnectUri ? intl.formatMessage(common.copied) : intl.formatMessage(common.copyLink)}
                  >
                    {copiedConnectUri ? (
                      <Check className='size-4 text-success' />
                    ) : (
                      <Copy className='size-4' />
                    )}
                  </Button>
                </div>
              )}
              <button
                type='button'
                onClick={handleConnectCancel}
                className='text-sm text-muted-foreground hover:text-foreground'
              >
                <FormattedMessage {...common.back} />
              </button>
            </div>
          ) : (
            <>
              {joinMode && onSignupClick && (
                <div className='space-y-4'>
                  <Button
                    type='button'
                    size='lg'
                    className='h-12 w-full clip-corner-lg text-base font-medium'
                    onClick={() => { onClose(); onSignupClick(); }}
                  >
                    <FormattedMessage id="loginScreen.createAccount" defaultMessage="Create account" />
                  </Button>
                  <div className='flex items-center gap-3'>
                    <div className='h-px flex-1 bg-border' />
                    <span className='text-xs uppercase tracking-wider text-muted-foreground'>
                      <FormattedMessage id="loginScreen.orLogIn" defaultMessage="or log in" />
                    </span>
                    <div className='h-px flex-1 bg-border' />
                  </div>
                </div>
              )}

              {/* Capacitor Android only, with a signer installed. */}
              <AndroidSignerOptions onLogin={() => { onLogin(); onClose(); }} />

              {hasExtension && (
                <div className="space-y-3">
                  {extensionError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>{extensionError}</AlertDescription>
                    </Alert>
                  )}
                  <Button
                    variant={joinMode ? 'secondary' : 'default'}
                    className="w-full h-12 clip-corner-lg"
                    onClick={handleExtensionLogin}
                    disabled={isLoading}
                  >
                    {isLoading ? <FormattedMessage id="loginScreen.loggingInDots" defaultMessage="Logging in..." /> : <FormattedMessage id="loginScreen.logInWithExtension" defaultMessage="Log in with Extension" />}
                  </Button>
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs uppercase tracking-wider text-muted-foreground"><FormattedMessage id="loginScreen.or" defaultMessage="or" /></span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                </div>
              )}

              <form onSubmit={(e) => { e.preventDefault(); handleLogin(); }} className='space-y-3'>
                <div className='relative'>
                  <Input
                    type='password'
                    value={loginInput}
                    onChange={(e) => {
                      setLoginInput(e.target.value);
                      if (loginError) setLoginError('');
                    }}
                    placeholder={intl.formatMessage({ id: "loginScreen.inputPlaceholder", defaultMessage: "nsec1…, ncryptsec1… or bunker://…" })}
                    autoComplete='off'
                    aria-invalid={!!loginError}
                    className='pr-12'
                  />
                  <input
                    type='file'
                    accept='.txt'
                    className='hidden'
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  <DropdownMenu touchSheet>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        className='absolute right-0 top-0 h-full w-10 touch:w-11 clip-corner-lg text-muted-foreground hover:bg-muted/60'
                        title={intl.formatMessage({ id: "loginScreen.moreOptions", defaultMessage: "More login options" })}
                        aria-label={intl.formatMessage({ id: "loginScreen.moreOptions", defaultMessage: "More login options" })}
                      >
                        <ChevronDown className='h-4 w-4 text-muted-foreground' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuItem
                        onSelect={() => fileInputRef.current?.click()}
                        disabled={isFileLoading}
                        className='flex items-center gap-2 cursor-pointer'
                      >
                        <FileUp className='h-4 w-4' />
                        <FormattedMessage id="loginScreen.selectKeyFile" defaultMessage="Select key file" />
                      </DropdownMenuItem>
                      {/* Both hand-offs are offered everywhere: desktop signers
                          (e.g. Opal, which registers the nostrconnect:// scheme)
                          open from the same link mobile signers deep-link to. */}
                      <DropdownMenuItem
                        onSelect={handleShowQr}
                        className='flex items-center gap-2 cursor-pointer'
                      >
                        <QrCode className='h-4 w-4' />
                        <FormattedMessage id="loginScreen.connectRemoteSigner" defaultMessage="Connect remote signer" />
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={handleOpenSignerApp}
                        className='flex items-center gap-2 cursor-pointer'
                      >
                        <ExternalLink className='h-4 w-4' />
                        <FormattedMessage id="loginScreen.openSignerApp" defaultMessage="Open signer app" />
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {encryptedBackup && (
                  <div className='space-y-2 text-left'>
                    <div className='relative'>
                      <Lock className='pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
                      <Input
                        type='password'
                        value={backupPassword}
                        onChange={(e) => {
                          setBackupPassword(e.target.value);
                          if (loginError) setLoginError('');
                        }}
                        placeholder={intl.formatMessage({ id: "loginScreen.ncryptsecPassword", defaultMessage: "Password for this encrypted key" })}
                        autoComplete='current-password'
                        autoFocus
                        aria-label={intl.formatMessage({ id: "loginScreen.ncryptsecPassword", defaultMessage: "Password for this encrypted key" })}
                        className='pl-9 clip-corner-lg bg-background border-transparent'
                      />
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      <FormattedMessage
                        id="loginScreen.ncryptsecHint"
                        defaultMessage="NIP-49 encrypted key. It's unlocked on this device; the password never leaves it."
                      />
                    </p>
                    {backupHeader?.keySecurity === 'insecure' && (
                      <p className='text-xs text-destructive'>
                        <FormattedMessage
                          id="loginScreen.ncryptsecInsecureHint"
                          defaultMessage="This backup says its key was once stored unencrypted. If it has ever been somewhere you don't control, make a new key."
                        />
                      </p>
                    )}
                  </div>
                )}
                {loginError && <p className='text-sm text-destructive'>{loginError}</p>}

                {/* Secondary so the screen has one primary action. */}
                <Button
                  type='submit'
                  size='lg'
                  variant={joinMode ? 'secondary' : 'default'}
                  disabled={isLoading || isFileLoading || !loginInput.trim() || (encryptedBackup && !backupPassword)}
                  className='w-full clip-corner-lg'
                >
                  {isLoading ? (
                    encryptedBackup ? (
                      <FormattedMessage id="loginScreen.unlocking" defaultMessage="Unlocking…" />
                    ) : (
                      <FormattedMessage id="loginScreen.loggingIn" defaultMessage="Logging in…" />
                    )
                  ) : encryptedBackup ? (
                    <FormattedMessage id="loginScreen.unlockAndLogIn" defaultMessage="Unlock and log in" />
                  ) : (
                    <FormattedMessage id="loginScreen.logIn" defaultMessage="Log in" />
                  )}
                </Button>
              </form>

              {/* Covers every method above: signer app, extension, key and Create account. */}
              <SignupTerms action={joinMode ? 'continue' : 'login'} />
            </>
          )}
        </div>
      </div>
      </TermsGate>
    </WizardShell>,
    document.body,
  );
};

/**
 * With an account server configured, the email-and-password step comes first;
 * the key screen follows only for an account that has no key yet. Without one,
 * this is the key screen and nothing else.
 */
const LoginScreen: React.FC<LoginScreenProps> = (props) => {
  const account = useAccountState();
  // Named `use…` but not a hook (a localStorage read), and called before the
  // early return so the linter's hook-order rule stays satisfied.
  const keyOnly = useKeyInstead();
  if (!accountsEnabled() || accountReady(account) || keyOnly) {
    return <KeyLoginScreen {...props} accountExists={account !== null} />;
  }
  return (
    <AccountGate
      isOpen={props.isOpen}
      onClose={props.onClose}
      onLogin={props.onLogin}
      onUseKey={() => {
        skipAccountGate();
        props.onClose();
      }}
    />
  );
};

export default LoginScreen;
