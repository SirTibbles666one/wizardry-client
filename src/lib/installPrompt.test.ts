// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getInstallState, installInstallPromptCapture, promptInstall, subscribeInstallState } from "@/lib/installPrompt";

function offer(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & Record<string, unknown>;
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome, platform: "web" });
  window.dispatchEvent(event);
  return event;
}

describe("install prompt capture", () => {
  beforeAll(() => installInstallPromptCapture());

  it("keeps the browser's offer from boot until something asks for it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInstallState(listener);
    const event = offer("dismissed");
    expect(event.defaultPrevented).toBe(true);
    expect(getInstallState().canInstall).toBe(true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("opens the dialog once, then has nothing more to offer", async () => {
    offer("dismissed");
    expect(await promptInstall()).toBe("dismissed");
    expect(getInstallState().canInstall).toBe(false);
    expect(await promptInstall()).toBeNull();
  });

  it("counts the app as installed after appinstalled", () => {
    offer("accepted");
    window.dispatchEvent(new Event("appinstalled"));
    expect(getInstallState()).toMatchObject({ canInstall: false, isInstalled: true });
  });
});
