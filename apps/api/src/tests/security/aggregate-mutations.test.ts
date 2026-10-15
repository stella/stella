import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getAggregateMutationDeclaration } from "@/api/lib/db/aggregate-mutation-declaration";
import { isLocalDevOpen } from "@/api/runtime-mode";
import api from "@/api/server";

import { enumerateAggregateMutations } from "../../../../../scripts/check-aggregate-mutations.ts";

const root = path.resolve(import.meta.dir, "../../../../..");
const mutationMethods = ["POST", "PUT", "PATCH", "DELETE", "ALL"];

describe("aggregate mutation route composition", () => {
  test("the actual route table matches the statically enumerated mutation surface", () => {
    const registrations = enumerateAggregateMutations((file) => {
      const absolute = path.join(root, file);
      return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
    }).filter(
      (route) => isLocalDevOpen() || !route.file.includes("/handlers/dev/"),
    );
    // The source guard owns exact handler identities; this catches composition
    // drift, including factories, conditional dev imports and the auth mount.
    expect(registrations.length).toBeGreaterThan(400);
    for (const method of mutationMethods) {
      const sourceRoutes = registrations.filter(
        (route) => (route.method === "MOUNT" ? "ALL" : route.method) === method,
      );
      const actualRoutes = api.routes.filter(
        (route) => route.method === method,
      );
      expect({ method, count: actualRoutes.length }).toEqual({
        method,
        count: sourceRoutes.length,
      });
      const declaredRoutes = actualRoutes.filter(
        (route) =>
          typeof route.handler === "function" &&
          getAggregateMutationDeclaration(route.handler) !== undefined,
      );
      expect({ method, count: declaredRoutes.length }).toEqual({
        method,
        count: sourceRoutes.filter((route) => route.declared).length,
      });
    }
  });
});
