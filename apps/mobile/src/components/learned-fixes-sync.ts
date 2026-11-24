import { randomUUID } from "expo-crypto";

import type { AccessTokenSource } from "@/connection/session";
import { deviceAccountStore } from "@/native/account-store";
import { syncLearnedFixes } from "@/state/dictation-learned";

/**
 * Syncs the signed-in account's learned dictation fixes with its other
 * devices; the fixes as stored after, or nothing when no sync ran.
 */
export const syncLearned = async (source: AccessTokenSource) =>
  await syncLearnedFixes({
    store: deviceAccountStore,
    fetch,
    source,
    newId: randomUUID,
  });
