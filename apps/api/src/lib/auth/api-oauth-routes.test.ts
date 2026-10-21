import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { API_OAUTH_ROUTES } from "@/api/lib/auth/api-access-token";
import { isRecord } from "@/api/lib/type-guards";
import api from "@/api/server";

import { deriveCapabilityId } from "../../../scripts/lib/capability-catalog";

const REPO_ROOT = new URL("../../../../../", import.meta.url);

const catalog = new Map(
  readCapabilityCatalog().flatMap((entry) =>
    isRecord(entry) && typeof entry["id"] === "string"
      ? [[entry["id"], entry] as const]
      : [],
  ),
);

const handlerConfigOf = (module: unknown) => {
  const endpoint = isRecord(module) ? module["default"] : undefined;
  const config = isRecord(endpoint) ? endpoint["config"] : undefined;
  return {
    handler: isRecord(endpoint) ? endpoint["handler"] : undefined,
    accountAccess: isRecord(config) ? config["accountAccess"] : undefined,
  };
};

describe("the routes an API access token opens", () => {
  test.each(Object.entries(API_OAUTH_ROUTES))(
    "%s is the live route of its handler, at the scope its capability carries",
    async (key, { handler, scope }) => {
      const [method, path] = key.split(" ");
      const route = api.routes.find(
        (candidate) => candidate.method === method && candidate.path === path,
      );
      expect(route).toBeDefined();

      const endpoint = handlerConfigOf(
        await import(new URL(handler, REPO_ROOT).pathname),
      );
      expect(route?.handler).toBe(endpoint.handler);
      expect(endpoint.accountAccess).not.toBe(ACCOUNT_ACCESS.accountControl);

      const capability = catalog.get(
        deriveCapabilityId({ file: handler, exportName: undefined }),
      );
      expect({
        access: capability?.["access"],
        scope: capability?.["scope"],
      }).toEqual({
        access: method === "GET" ? "read" : "write",
        scope,
      });
    },
  );
});
