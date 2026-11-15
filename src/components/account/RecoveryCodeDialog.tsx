import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Check, Copy, Download, LifeBuoy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { FormattedMessage, useIntl } from "@/i18n";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { APP_NAME } from "@/lib/platform";

interface RecoveryCodeDialogProps {
  /** The code to show; null keeps the dialog closed. */
  code: string | null;
  onDone: () => void;
}

/**
 * Shows the recovery code once. It exists nowhere else, so the dialog cannot
 * be dismissed until the code has been copied or downloaded.
 */
export function RecoveryCodeDialog({ code, onDone }: RecoveryCodeDialogProps) {
  const intl = useIntl();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!code) return;
    try {
      await writeClipboardText(code);
      setCopied(true);
      setSaved(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: intl.formatMessage({ id: "recoveryCode.copyFailed", defaultMessage: "Couldn't copy the code. Select it and copy it by hand, or write it down." }),
        variant: "destructive",
      });
      // The code is on screen and selectable, so writing it down still counts.
      setSaved(true);
    }
  };

  const download = () => {
    if (!code) return;
    const text = intl.formatMessage(
      {
        id: "recoveryCode.fileBody",
        defaultMessage: "{app} recovery code\n\n{code}\n\nKeep this somewhere safe. With the code sent to your email, it gets your key back if you forget your password. Anyone who has it and your email inbox can take your account.",
      },
      { app: APP_NAME, code },
    );
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${APP_NAME.toLowerCase()}-recovery-code.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  const finish = () => {
    setSaved(false);
    onDone();
  };

  const title = intl.formatMessage({ id: "recoveryCode.title", defaultMessage: "Save your recovery code" });

  return (
    <Dialog open={code !== null} onOpenChange={() => undefined}>
      <ChromeDialogContent
        title={title}
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <ChromeDialogHeader
          icon={LifeBuoy}
          tone="warning"
          title={intl.formatMessage({ id: "recoveryCode.heading", defaultMessage: "save your recovery code" })}
          description={intl.formatMessage({
            id: "recoveryCode.description",
            defaultMessage: "If you forget your password, this code is the only way to get your key back. We can't see it and can't send it again.",
          })}
        />
        <p
          className="mt-5 select-all break-all bg-muted px-3 py-4 text-center font-mono text-lg font-semibold tracking-wider text-foreground clip-corner-lg"
          data-testid="recovery-code"
        >
          {code}
        </p>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          <FormattedMessage
            id="recoveryCode.lossWarning"
            defaultMessage="Lose both your password and this code, and your key is gone for good."
          />
        </p>
        <ChromeDialogFooter>
          <Button type="button" variant="secondary" className="h-11" onClick={copy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            <FormattedMessage id="recoveryCode.copy" defaultMessage="Copy" />
          </Button>
          {!Capacitor.isNativePlatform() && (
            <Button type="button" variant="secondary" className="h-11" onClick={download}>
              <Download className="size-4" />
              <FormattedMessage id="recoveryCode.download" defaultMessage="Download" />
            </Button>
          )}
        </ChromeDialogFooter>
        <Button type="button" className="mt-2 h-11 w-full clip-corner-lg" disabled={!saved} onClick={finish}>
          <FormattedMessage id="recoveryCode.done" defaultMessage="I've saved it" />
        </Button>
      </ChromeDialogContent>
    </Dialog>
  );
}
