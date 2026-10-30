import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { API_OAUTH_ROUTES } from "@/api/lib/auth/api-access-token";
import { isRecord } from "@/api/lib/type-guards";
import { apiApp } from "@/api/server";

import { deriveCapabilityId } from "../../../scripts/lib/capability-catalog";

const REPO_ROOT = new URL("../../../../../", import.meta.url);

const catalog = new Map(
  readCapabilityCatalog().flatMap((entry) =>
    isRecord(entry) && typeof entry["id"] === "string"
      ? [[entry["id"], entry] as const]
      : [],
  ),
);

const handlerConfigOf = (module: unknown, exportName: string) => {
  const endpoint = isRecord(module) ? module[exportName] : undefined;
  const config = isRecord(endpoint) ? endpoint["config"] : undefined;
  return {
    endpoint,
    accountAccess: isRecord(config) ? config["accountAccess"] : undefined,
    access: isRecord(config) ? config["access"] : undefined,
    mcp: isRecord(config) ? config["mcp"] : undefined,
  };
};

const ROUTES: readonly (readonly [
  string,
  {
    readonly handler: string;
    readonly scope: string;
    readonly exportName?: string;
    readonly uncataloged?: string;
  },
])[] = Object.entries(API_OAUTH_ROUTES);

describe("the routes an API access token opens", () => {
  test.each(ROUTES)(
    "%s is the live route of its handler, at the scope its capability carries",
    async (key, { handler, scope, exportName, uncataloged }) => {
      const [method, path] = key.split(" ");
      const route = apiApp.routes.find(
        (candidate) => candidate.method === method && candidate.path === path,
      );
      expect(route).toBeDefined();

      const endpoint = handlerConfigOf(
        await import(new URL(handler, REPO_ROOT).pathname),
        exportName ?? "default",
      );
      const definition: unknown = route?.definition;
      expect(definition).toBe(endpoint.endpoint);
      expect(endpoint.accountAccess).not.toBe(ACCOUNT_ACCESS.accountControl);

      const capability = catalog.get(
        deriveCapabilityId({ file: handler, exportName }),
      );
      if (uncataloged !== undefined) {
        // A realtime handler has no capability to carry a scope; it must
        // be internal for exactly the reason its entry gives.
        expect(capability).toBeUndefined();
        expect(endpoint.mcp).toEqual({ type: "internal", reason: uncataloged });
        return;
      }
      expect({
        access: capability?.["access"],
        scope: capability?.["scope"],
      }).toEqual({
        // A POST that only reads (a query with a body) declares it.
        access: endpoint.access ?? (method === "GET" ? "read" : "write"),
        scope,
      });
    },
  );
});
