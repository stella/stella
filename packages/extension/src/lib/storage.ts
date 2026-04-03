import type { Matter, QueuedClip, RecentClip } from "../types";

const KEYS = {
  activeMatter: "stella:activeMatter",
  recentClips: "stella:recentClips",
  offlineQueue: "stella:offlineQueue",
  bearerToken: "stella:bearerToken",
} as const;

const MAX_RECENT_CLIPS = 50;

/**
 * Typed wrapper around chrome.storage.local.get().
 * Chrome returns `{ [key: string]: any }`; this narrows
 * via a single suppression point instead of per-call casts.
 */
// eslint-disable-next-line typescript/no-unnecessary-type-parameters
const getStorageValue = async <T>(key: string): Promise<T | undefined> => {
  const result = await chrome.storage.local.get(key);
  // SAFETY: chrome.storage returns untyped values;
  // we control all writes to these keys.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return result[key] as T | undefined;
};

export const storage = {
  getActiveMatter: async (): Promise<Matter | null> => {
    const value = await getStorageValue<Matter>(KEYS.activeMatter);
    return value ?? null;
  },

  setActiveMatter: async (matter: Matter): Promise<void> => {
    await chrome.storage.local.set({
      [KEYS.activeMatter]: matter,
    });
  },

  getRecentClips: async (): Promise<RecentClip[]> => {
    const value = await getStorageValue<RecentClip[]>(KEYS.recentClips);
    return value ?? [];
  },

  addRecentClip: async (clip: RecentClip): Promise<void> => {
    const existing = await storage.getRecentClips();
    const updated = [clip, ...existing].slice(0, MAX_RECENT_CLIPS);
    await chrome.storage.local.set({
      [KEYS.recentClips]: updated,
    });
  },

  getOfflineQueue: async (): Promise<QueuedClip[]> => {
    const value = await getStorageValue<QueuedClip[]>(KEYS.offlineQueue);
    return value ?? [];
  },

  addToOfflineQueue: async (clip: QueuedClip): Promise<void> => {
    const existing = await storage.getOfflineQueue();
    await chrome.storage.local.set({
      [KEYS.offlineQueue]: [...existing, clip],
    });
  },

  removeFromOfflineQueue: async (id: string): Promise<void> => {
    const existing = await storage.getOfflineQueue();
    const updated = existing.filter((clip) => clip.id !== id);
    await chrome.storage.local.set({
      [KEYS.offlineQueue]: updated,
    });
  },

  clearOfflineQueue: async (): Promise<void> => {
    await chrome.storage.local.remove(KEYS.offlineQueue);
  },

  getBearerToken: async (): Promise<string | null> => {
    const value = await getStorageValue<string>(KEYS.bearerToken);
    return value ?? null;
  },

  setBearerToken: async (token: string): Promise<void> => {
    await chrome.storage.local.set({
      [KEYS.bearerToken]: token,
    });
  },

  clearBearerToken: async (): Promise<void> => {
    await chrome.storage.local.remove(KEYS.bearerToken);
  },
};
