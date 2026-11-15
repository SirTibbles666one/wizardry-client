import { useEffect } from "react";

import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";
import { onDesktopWebUpdateReady, restartForDesktopWebUpdate } from "@/lib/desktop";

/** In-app "restart to update" notice for a web bundle the desktop shell installed. */
export function DesktopUpdateToast() {
  useEffect(
    () =>
      onDesktopWebUpdateReady(() => {
        toast({
          title: t({ id: "desktopUpdateToast.title", defaultMessage: "Update available" }),
          description: t({ id: "desktopUpdateToast.description", defaultMessage: "Restart Wizardry to use the new version." }),
          duration: Infinity,
          action: (
            <ToastAction altText={t({ id: "desktopUpdateToast.restartAlt", defaultMessage: "Restart Wizardry to update" })} onClick={restartForDesktopWebUpdate}>
              {t({ id: "desktopUpdateToast.restart", defaultMessage: "Restart" })}
            </ToastAction>
          ),
        });
      }),
    [],
  );

  return null;
}
