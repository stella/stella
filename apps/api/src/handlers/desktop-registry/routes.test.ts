import { expect, test } from "bun:test";

import { DESKTOP_REGISTRY_PERMISSION } from "@/api/handlers/desktop-registry/config";
import grant from "@/api/handlers/desktop-registry/grant";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

test("registering desktop routes preserves the grant authorization contract", () => {
  desktopRegistryRoute.compile();

  expect(grant.config.permissions).toEqual(DESKTOP_REGISTRY_PERMISSION);
  expect(hasMemberPermission({ role: "owner" }, grant.config.permissions)).toBe(
    true,
  );
});
