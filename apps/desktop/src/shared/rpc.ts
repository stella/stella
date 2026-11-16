import { isDesktopEditFileType } from "@stll/api-contract";
import type {
  AppSnapshot,
  RecoveryAccess,
  RecoveryStatus,
} from "@stll/api-contract/desktop-rpc";

export type {
  AppSnapshot,
  DesktopAccountSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  LinkedAccountSnapshot,
  OpenFileRequest,
  OpenFileResponse,
  DocumentRecoverySnapshot,
  RecoveryTarget,
  SessionSnapshot,
  TrustedSelfHostConnection,
} from "@stll/api-contract/desktop-rpc";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const RECOVERY_STATUSES = { pending: true, available: true } satisfies Record<
  RecoveryStatus,
  true
>;
const RECOVERY_ACCESS = {
  available: true,
  signInRequired: true,
} satisfies Record<RecoveryAccess, true>;

const isDocumentRecovery = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["unassigned"] === "boolean" &&
    typeof value["pending"] === "boolean" &&
    typeof value["access"] === "string" &&
    Object.hasOwn(RECOVERY_ACCESS, value["access"]) &&
    Array.isArray(value["edits"]) &&
    value["edits"].every(
      (edit) =>
        isRecord(edit) &&
        typeof edit["id"] === "string" &&
        typeof edit["fileName"] === "string" &&
        typeof edit["status"] === "string" &&
        Object.hasOwn(RECOVERY_STATUSES, edit["status"]),
    )
  );
};

export const isAppSnapshot = (value: unknown): value is AppSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isDocumentRecovery(value["documentRecovery"]) &&
    typeof value["bridgePort"] === "number" &&
    typeof value["bridgeVersion"] === "number" &&
    isStringArray(value["capabilities"]) &&
    typeof value["runningSince"] === "string" &&
    Array.isArray(value["sessions"]) &&
    value["sessions"].every(
      (session) =>
        isRecord(session) && isDesktopEditFileType(session["fileType"]),
    ) &&
    Array.isArray(value["trustedSelfHostConnections"]) &&
    isRecord(value["notificationPreferences"]) &&
    isRecord(value["update"])
  );
};
