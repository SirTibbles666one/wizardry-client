import { isIOS, isStandalonePwa } from "@/lib/platform";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export interface InstallState {
  /** The browser has offered an install dialog this page can open. */
  canInstall: boolean;
  /** Running as an installed app (home screen, dock or app window). */
  isInstalled: boolean;
  /** iOS has no dialog to open: Share › Add to Home Screen, by hand. */
  needsManualInstall: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let state: InstallState = { canInstall: false, isInstalled: false, needsManualInstall: false };
const listeners = new Set<() => void>();

function publish(): void {
  const isInstalled = installed || isStandalonePwa();
  state = { canInstall: !!deferred && !isInstalled, isInstalled, needsManualInstall: isIOS() && !isInstalled };
  for (const listener of listeners) listener();
}

/**
 * Listen from boot. The browser fires `beforeinstallprompt` once, early in
 * page load, so a listener added when some screen mounts misses it.
 */
export function installInstallPromptCapture(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    publish();
  });
  publish();
}

export function getInstallState(): InstallState {
  return state;
}

export function subscribeInstallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens the browser's install dialog; null when there is none to open. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  const event = deferred;
  if (!event) return null;
  // A captured event opens its dialog once.
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  publish();
  return outcome;
}
