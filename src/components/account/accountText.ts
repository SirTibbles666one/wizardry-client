import { defineMessage, type IntlShape } from "@/i18n";
import { AccountError } from "@/account/client";

const MESSAGES = {
  invalid_credentials: defineMessage({ id: "accountErrors.invalidCredentials", defaultMessage: "That email and password don't match an account." }),
  unverified: defineMessage({ id: "accountErrors.unverified", defaultMessage: "This email isn't confirmed yet. Create the account again to get a new code." }),
  invalid_code: defineMessage({ id: "accountErrors.invalidCode", defaultMessage: "That code isn't right, or it has expired. Check it and try again." }),
  rate_limited: defineMessage({ id: "accountErrors.rateLimited", defaultMessage: "Too many tries. Wait a few minutes, then try again." }),
  mail_failed: defineMessage({ id: "accountErrors.mailFailed", defaultMessage: "We couldn't send the email. Check the address and try again." }),
  no_recovery: defineMessage({ id: "accountErrors.noRecovery", defaultMessage: "This account has no recovery code. You can only start over with a new key." }),
  network: defineMessage({ id: "accountErrors.network", defaultMessage: "Couldn't reach the account server. Check your connection and try again." }),
  unauthorized: defineMessage({ id: "accountErrors.unauthorized", defaultMessage: "Your sign-in has expired. Sign in again." }),
  generic: defineMessage({ id: "accountErrors.generic", defaultMessage: "Something went wrong. Try again." }),
} as const;

/** What to tell the person for a failed account call. Never the raw error. */
export function accountErrorText(intl: IntlShape, error: unknown): string {
  const code = error instanceof AccountError ? error.code : "generic";
  return intl.formatMessage(code in MESSAGES ? MESSAGES[code as keyof typeof MESSAGES] : MESSAGES.generic);
}

export const MIN_PASSWORD_LENGTH = 10;
