import { expect, test } from "bun:test";

import grant from "@/api/handlers/desktop-registry/grant";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { DESKTOP_REGISTRY_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

test("registering desktop routes preserves the grant authorization contract", () => {
  desktopRegistryRoute.compile();

  expect(grant.config.permissions).toEqual(DESKTOP_REGISTRY_PERMISSION);
  expect(hasMemberPermission({ role: "owner" }, grant.config.permissions)).toBe(
    true,
  );
});
