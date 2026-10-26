import { seedLegacyBrowserStorageForTest } from "@/lib/account/browser-storage";

/** Test-only seeding for read/delete-only legacy families. */
export const seedLegacyBrowserStorage = (key: string, value: string): void => {
  seedLegacyBrowserStorageForTest(key, value);
};
