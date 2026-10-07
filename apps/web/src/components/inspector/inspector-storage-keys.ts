import { ownerStorageKey } from "@/lib/account/storage-key";

/** Whose inspector this is: one user inside one organization. */
export type InspectorStorageScope = {
  userId: string;
  organizationId: string;
};

const INSPECTOR_MINIMIZED_STORAGE_PREFIX = "stella:inspector-minimized:v1";
const INSPECTOR_STATE_STORAGE_PREFIX = "stella:inspector-state:v1";

/** Where one user's minimized flag for one organization is kept. */
export const inspectorMinimizedStorageKey = ({
  userId,
  organizationId,
}: InspectorStorageScope) =>
  ownerStorageKey(`${INSPECTOR_MINIMIZED_STORAGE_PREFIX}:${organizationId}:`, {
    kind: "user",
    userId,
  });

/** Where one user's open tabs for one organization are kept. */
export const inspectorStateStorageKey = ({
  userId,
  organizationId,
}: InspectorStorageScope) =>
  ownerStorageKey(`${INSPECTOR_STATE_STORAGE_PREFIX}:${organizationId}:`, {
    kind: "user",
    userId,
  });
