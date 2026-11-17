import { describe, expect, it, vi } from "vitest";

import {
  navigateOrOffline,
  OFFLINE_ASSETS,
  OFFLINE_CACHE,
  OFFLINE_PAGE,
  offlineAssetOrNetwork,
  precacheOffline,
  pruneOfflineCaches,
} from "@/sw/offline";

/** A CacheStorage holding named caches of path → body. */
function fakeCaches(initial: Record<string, Record<string, string>> = {}) {
  const store = new Map(Object.entries(initial).map(([name, files]) => [name, new Map(Object.entries(files))]));
  const pathOf = (r: RequestInfo | URL) => new URL(typeof r === "string" ? r : r instanceof URL ? r.href : r.url, "https://w.example").pathname;
  const storage = {
    open: vi.fn(async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const files = store.get(name)!;
      return { addAll: async (paths: string[]) => paths.forEach((p) => files.set(p, `cached ${p}`)) };
    }),
    keys: async () => [...store.keys()],
    delete: vi.fn(async (name: string) => store.delete(name)),
    match: async (r: RequestInfo | URL, opts?: { cacheName?: string }) => {
      const body = store.get(opts?.cacheName ?? "")?.get(pathOf(r));
      return body === undefined ? undefined : new Response(body);
    },
  };
  return { storage: storage as unknown as CacheStorage, store };
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("the offline fallback", () => {
  it("precaches the offline page and its script, and nothing of the app", async () => {
    const { storage, store } = fakeCaches();
    await precacheOffline(storage);
    expect([...store.get(OFFLINE_CACHE)!.keys()]).toEqual(OFFLINE_ASSETS);
    expect(OFFLINE_ASSETS).not.toContain("/index.html");
  });

  it("answers a navigation from the network whenever the network answers", async () => {
    const { storage } = fakeCaches({ [OFFLINE_CACHE]: { [OFFLINE_PAGE]: "offline" } });
    const res = await navigateOrOffline(new Request("https://w.example/dm"), async () => new Response("app"), storage);
    expect(await res.text()).toBe("app");
  });

  it("passes an error page from the server through rather than hiding it", async () => {
    const { storage } = fakeCaches({ [OFFLINE_CACHE]: { [OFFLINE_PAGE]: "offline" } });
    const res = await navigateOrOffline(new Request("https://w.example/x"), async () => new Response("down", { status: 502 }), storage);
    expect(res.status).toBe(502);
  });

  it("shows the offline page when the request itself fails", async () => {
    const { storage } = fakeCaches({ [OFFLINE_CACHE]: { [OFFLINE_PAGE]: "offline" } });
    const res = await navigateOrOffline(new Request("https://w.example/dm/abc"), offline, storage);
    expect(await res.text()).toBe("offline");
  });

  it("rethrows when there is no offline page to show", async () => {
    const { storage } = fakeCaches();
    await expect(navigateOrOffline(new Request("https://w.example/"), offline, storage)).rejects.toThrow("Failed to fetch");
  });

  it("serves the offline script from the cache only when offline", async () => {
    const { storage } = fakeCaches({ [OFFLINE_CACHE]: { "/offline.js": "cached" } });
    const req = new Request("https://w.example/offline.js");
    expect(await (await offlineAssetOrNetwork(req, async () => new Response("fresh"), storage)).text()).toBe("fresh");
    expect(await (await offlineAssetOrNetwork(req, offline, storage)).text()).toBe("cached");
  });

  it("deletes older offline caches and leaves every other cache alone", async () => {
    const { storage, store } = fakeCaches({
      "wizardry-offline-v0": {},
      [OFFLINE_CACHE]: {},
      "armada-share-inbox": {},
    });
    await pruneOfflineCaches(storage);
    expect([...store.keys()].sort()).toEqual([OFFLINE_CACHE, "armada-share-inbox"].sort());
  });
});
