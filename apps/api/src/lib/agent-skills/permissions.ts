import type { PermissionInput } from "@stll/permissions";

export const SKILL_READ_PERMISSIONS = {
  chat: ["create"],
} as const satisfies PermissionInput;
