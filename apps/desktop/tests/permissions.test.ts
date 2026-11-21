import { describe, expect, test } from "bun:test";

import { PERMISSION_STATUSES, PERMISSIONS } from "../src/shared/permissions";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const NATIVE_PERMISSIONS = readNativeSource("permissions.rs");

describe("native permission contract", () => {
  test("permissions match the native enum", () => {
    expect(rustEnumVariants(NATIVE_PERMISSIONS, "Permission")).toEqual([
      ...PERMISSIONS,
    ]);
  });

  test("permission statuses match the native enum", () => {
    expect(rustEnumVariants(NATIVE_PERMISSIONS, "PermissionStatus")).toEqual([
      ...PERMISSION_STATUSES,
    ]);
  });
});
