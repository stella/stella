import { isDesktopEditFileType } from "@stll/api-contract";
import type { AppSnapshot } from "@stll/api-contract/desktop-rpc";

export type {
  AppSnapshot,
  DesktopAccountSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  LinkedAccountSnapshot,
  OpenFileRequest,
  OpenFileResponse,
  SessionSnapshot,
  TrustedSelfHostConnection,
} from "@stll/api-contract/desktop-rpc";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const isAppSnapshot = (value: unknown): value is AppSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  return (
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
