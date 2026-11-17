import { useSyncExternalStore } from "react";

import { getInstallState, promptInstall, subscribeInstallState } from "@/lib/installPrompt";

/** The PWA install offer captured at boot (`installInstallPromptCapture`). */
export function useInstallPrompt() {
  const state = useSyncExternalStore(subscribeInstallState, getInstallState, getInstallState);
  return { ...state, install: promptInstall };
}
