import { Download, FileText, LifeBuoy, Mail, ScrollText, Shield } from "lucide-react";
import { useContext } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsSearchingContext } from "@/components/settings/settingsNav";
import { FormattedMessage, useIntl } from "@/i18n";
import { appVersionLabel } from "@/lib/appVersion";
import { SUPPORT_EMAIL } from "@/lib/platform";
import { APPS_PUBLISHED } from "@/lib/releases";

/** Settings › Help & support. */
export function SupportSettings() {
  const intl = useIntl();
  return (
    <SettingsGroup id="support">
      <SettingsRow
        icon={LifeBuoy}
        tone="success"
        label={intl.formatMessage({ id: "aboutSettings.helpSafety", defaultMessage: "Help & safety" })}
        description={intl.formatMessage({ id: "aboutSettings.helpSafetyDescription", defaultMessage: "Blocking, hiding, muted words, reporting and getting help." })}
        to="/support"
      />
      <SettingsRow
        icon={Mail}
        tone="accent2"
        label={intl.formatMessage({ id: "aboutSettings.contactSupport", defaultMessage: "Contact support" })}
        description={intl.formatMessage({ id: "aboutSettings.contactSupportDescription", defaultMessage: "Report inappropriate activity or ask for help at {email}." }, { email: SUPPORT_EMAIL })}
        href={`mailto:${SUPPORT_EMAIL}`}
        chevron
      />
    </SettingsGroup>
  );
}

/** Settings › About Armada: version, release notes, downloads and the legal pages. */
export function AboutSettings() {
  const intl = useIntl();
  const searching = useContext(SettingsSearchingContext);
  return (
    <>
      {!searching && (
        <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
          <span className="flex size-16 items-center justify-center clip-corner-lg bg-chrome neon-text">
            <svg width="36" height="36" viewBox="0 0 128 128" fill="none" aria-hidden>
              <path d="M64 10L114 64L64 118L14 64Z M64 30L94 64L64 98L34 64Z" fill-rule="evenodd" fill="currentColor" />
            </svg>
          </span>
          <div className="font-mono text-lg font-bold lowercase tracking-tight">wizardry</div>
          <div className="text-xs text-muted-foreground">
            <FormattedMessage id="aboutSettings.tagline" defaultMessage="Private communities that need no host." />
          </div>
        </div>
      )}

      <SettingsGroup id="about">
        <SettingsRow label={intl.formatMessage({ id: "aboutSettings.version", defaultMessage: "Version" })} value={<span className="tabular-nums">{appVersionLabel()}</span>} />
        <SettingsRow icon={ScrollText} tone="primary" label={intl.formatMessage({ id: "aboutSettings.whatsNew", defaultMessage: "What's new" })} to="/changelog" />
        {APPS_PUBLISHED && (
          <SettingsRow icon={Download} tone="accent2" label={intl.formatMessage({ id: "aboutSettings.getTheApps", defaultMessage: "Get the apps" })} to="/downloads" />
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon={FileText} tone="muted" label={intl.formatMessage({ id: "aboutSettings.terms", defaultMessage: "Terms of service" })} to="/terms" />
        <SettingsRow icon={Shield} tone="muted" label={intl.formatMessage({ id: "aboutSettings.privacyPolicy", defaultMessage: "Privacy policy" })} to="/privacy" />
      </SettingsGroup>
    </>
  );
}
