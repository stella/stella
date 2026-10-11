import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  getWriteContract,
  RAW_WRITE_CONTRACTS,
  writeContractRouteKey,
} from "@/api/lib/write-contract";
import { isLocalDevOpen } from "@/api/runtime-mode";
import api from "@/api/server";

import { enumerateWriteContracts } from "../../../../../scripts/check-write-contracts.ts";

const root = path.resolve(import.meta.dir, "../../../../..");
const mutationMethods = ["POST", "PUT", "PATCH", "DELETE", "ALL"];

describe("write contract route composition", () => {
  test("every composed mutation surface has its factory or custom transport declaration", () => {
    const registrations = enumerateWriteContracts((file) => {
      const absolute = path.join(root, file);
      return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
    }).filter(
      (route) => isLocalDevOpen() || !route.file.includes("/handlers/dev/"),
    );
    const rawKeys = new Set(Object.keys(RAW_WRITE_CONTRACTS));
    for (const method of mutationMethods) {
      const sourceRoutes = registrations.filter(
        (route) => (route.method === "MOUNT" ? "ALL" : route.method) === method,
      );
      expect(
        sourceRoutes.every(
          (route) => route.contract === "patch" || route.contract === "replace",
        ),
      ).toBe(true);
      const actualRoutes = api.routes.filter(
        (route) => route.method === method,
      );
      expect({ method, count: actualRoutes.length }).toEqual({
        method,
        count: sourceRoutes.length,
      });
      const factoryRoutes = actualRoutes.filter(
        (route) =>
          typeof route.handler === "function" &&
          getWriteContract(route.handler) !== undefined,
      );
      expect({ method, count: factoryRoutes.length }).toEqual({
        method,
        count: sourceRoutes.filter(
          (route) => !rawKeys.has(writeContractRouteKey(route.key)),
        ).length,
      });
    }
  });
});
