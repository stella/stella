import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import grant from "@/api/handlers/desktop-registry/grant";
import request from "@/api/handlers/desktop-registry/request";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { DESKTOP_REGISTRY_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

const FORMAT_ID = "11111111-1111-4111-8111-111111111111";

test("registering desktop routes preserves the grant authorization contract", () => {
  desktopRegistryRoute.compile();

  expect(grant.config.permissions).toEqual(DESKTOP_REGISTRY_PERMISSION);
  expect(hasMemberPermission({ role: "owner" }, grant.config.permissions)).toBe(
    true,
  );
});

describe("the desktop request body union", () => {
  test("accepts each request the desktop sends", () => {
    for (const body of [
      { type: "config" },
      { type: "revoke" },
      { type: "search", registry: "ares", query: "Stella" },
      { type: "format", registry: "ares", id: "123", formatId: FORMAT_ID },
      { type: "format", registry: "ares", id: "123", formatId: null },
      { type: "setDefaultFormat", registry: "ares", formatId: FORMAT_ID },
      { type: "setDefaultFormat", registry: "ares", formatId: null },
    ]) {
      expect([body, Value.Check(request.config.body, body)]).toEqual([
        body,
        true,
      ]);
    }
  });

  test("rejects a default-format request the handler could not scope", () => {
    for (const body of [
      { type: "setDefaultFormat", formatId: FORMAT_ID },
      { type: "setDefaultFormat", registry: "not-a-registry", formatId: null },
      { type: "setDefaultFormat", registry: "ares", formatId: "compact" },
      // The saved format is read under the caller's own organization, so an
      // organization the caller names is never a scope the handler accepts.
      {
        type: "setDefaultFormat",
        registry: "ares",
        formatId: FORMAT_ID,
        organizationId: "00000000-0000-4000-8000-000000000001",
      },
    ]) {
      expect([body, Value.Check(request.config.body, body)]).toEqual([
        body,
        false,
      ]);
    }
  });
});
