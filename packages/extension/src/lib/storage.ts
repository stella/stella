import type { Matter, QueuedClip, RecentClip } from "../types";

const KEYS = {
  activeMatter: "stella:activeMatter",
  recentClips: "stella:recentClips",
  offlineQueue: "stella:offlineQueue",
  bearerToken: "stella:bearerToken",
} as const;

const MAX_RECENT_CLIPS = 50;

export const storage = {
  getActiveMatter: async (): Promise<Matter | null> => {
    const result = await chrome.storage.local.get(
      KEYS.activeMatter,
    );
    // SAFETY: chrome.storage returns untyped values; we control writes.
    // eslint-disable-next-line typescript/consistent-type-assertions
    return (result[KEYS.activeMatter] as Matter | undefined) ?? null;
  },

  setActiveMatter: async (matter: Matter): Promise<void> => {
    await chrome.storage.local.set({
      [KEYS.activeMatter]: matter,
    });
  },

  getRecentClips: async (): Promise<RecentClip[]> => {
    const result = await chrome.storage.local.get(
      KEYS.recentClips,
    );
    return (
      // SAFETY: chrome.storage returns untyped values; we control writes.
      // eslint-disable-next-line typescript/consistent-type-assertions
      (result[KEYS.recentClips] as RecentClip[] | undefined) ?? []
    );
  },

  addRecentClip: async (clip: RecentClip): Promise<void> => {
    const existing = await storage.getRecentClips();
    const updated = [clip, ...existing].slice(0, MAX_RECENT_CLIPS);
    await chrome.storage.local.set({
      [KEYS.recentClips]: updated,
    });
  },

  getOfflineQueue: async (): Promise<QueuedClip[]> => {
    const result = await chrome.storage.local.get(
      KEYS.offlineQueue,
    );
    return (
      // SAFETY: chrome.storage returns untyped values; we control writes.
      // eslint-disable-next-line typescript/consistent-type-assertions
      (result[KEYS.offlineQueue] as QueuedClip[] | undefined) ?? []
    );
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
    const result = await chrome.storage.local.get(
      KEYS.bearerToken,
    );
    return (
      // SAFETY: chrome.storage returns untyped; we control writes.
      // eslint-disable-next-line typescript/consistent-type-assertions
      (result[KEYS.bearerToken] as string | undefined) ?? null
    );
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
