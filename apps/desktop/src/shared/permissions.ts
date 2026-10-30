/** The system permission rows the native side reports (`permissions.rs`). */

export const PERMISSIONS = [
  "notifications",
  "openAtLogin",
  "accessibility",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_STATUSES = [
  "notDetermined",
  "granted",
  "denied",
  "managed",
  "notApplicable",
] as const;

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export type PermissionRow = {
  permission: Permission;
  status: PermissionStatus;
};

export type PermissionsSnapshot = {
  rows: PermissionRow[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPermission = (value: unknown): value is Permission =>
  typeof value === "string" &&
  (PERMISSIONS as readonly string[]).includes(value);

const isPermissionStatus = (value: unknown): value is PermissionStatus =>
  typeof value === "string" &&
  (PERMISSION_STATUSES as readonly string[]).includes(value);

export const isPermissionsSnapshot = (
  value: unknown,
): value is PermissionsSnapshot =>
  isRecord(value) &&
  Array.isArray(value["rows"]) &&
  value["rows"].every(
    (row) =>
      isRecord(row) &&
      isPermission(row["permission"]) &&
      isPermissionStatus(row["status"]),
  );

/** How often a visible permissions view re-reads the OS: changes happen in
 *  System Settings, which sends no event this app can subscribe to. */
export const PERMISSION_REFRESH_MS = 2000;

export { isPermission };
