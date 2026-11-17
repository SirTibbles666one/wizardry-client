/**
 * The offline page: a fallback for a navigation the network could not answer.
 * Only these few static files are cached, never the app itself, so a new
 * deploy is always what loads when there is a connection.
 */
export const OFFLINE_CACHE = "wizardry-offline-v1";
export const OFFLINE_PAGE = "/offline.html";
export const OFFLINE_SCRIPT = "/offline.js";
export const OFFLINE_ASSETS = [OFFLINE_PAGE, OFFLINE_SCRIPT];

export async function precacheOffline(storage: CacheStorage): Promise<void> {
  const cache = await storage.open(OFFLINE_CACHE);
  await cache.addAll(OFFLINE_ASSETS);
}

/** Drops offline caches from earlier versions of the page. */
export async function pruneOfflineCaches(storage: CacheStorage): Promise<void> {
  const keys = await storage.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith("wizardry-offline-") && key !== OFFLINE_CACHE).map((key) => storage.delete(key)),
  );
}

/** Network first, always; the offline page only when the request itself fails. */
export async function navigateOrOffline(
  request: Request,
  fetchFn: (request: Request) => Promise<Response>,
  storage: CacheStorage,
): Promise<Response> {
  try {
    return await fetchFn(request);
  } catch (error) {
    const page = await storage.match(OFFLINE_PAGE, { cacheName: OFFLINE_CACHE });
    if (page) return page;
    throw error;
  }
}

/** Serves offline assets the offline page itself asks for while there is no network. */
export async function offlineAssetOrNetwork(
  request: Request,
  fetchFn: (request: Request) => Promise<Response>,
  storage: CacheStorage,
): Promise<Response> {
  try {
    return await fetchFn(request);
  } catch (error) {
    const hit = await storage.match(request, { cacheName: OFFLINE_CACHE });
    if (hit) return hit;
    throw error;
  }
}
