import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "./capability-catalog-data.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import {
  capabilityCommandPath,
  deriveCapabilityLeaf,
} from "./generate-capability-tree.js";

const catalog = parseCapabilityCatalog(readCapabilityCatalog());
if (catalog === null) {
  throw new TypeError("Invalid capability catalog");
}

describe("personal search history CLI", () => {
  test("exposes listing and deletion using the MCP capability contract", () => {
    for (const action of ["list", "delete", "clear"]) {
      const capability = catalog.find(
        ({ id }) => id === `search-history.${action}`,
      );
      expect(capability).toBeDefined();
      if (capability === undefined) {
        throw new TypeError(`Missing search history capability: ${action}`);
      }
      expect(capabilityCommandPath(capability.id)).toEqual([
        "capability",
        "search-history",
        action,
      ]);
      const { spec: leaf } = deriveCapabilityLeaf(capability);
      expect(leaf.capabilityId).toBe(capability.id);
      expect(leaf.destructive).toBe(action !== "list");
      if (action === "list") {
        expect(leaf.paginated).toBe(true);
        expect(leaf.paginationPart).toBe("query");
        expect(leaf.itemsKey).toBe("items");
      }
      expect(
        leaf.flags.some(
          ({ partPath }) =>
            partPath === "organizationId" || partPath === "userId",
        ),
      ).toBe(false);
      if (action === "clear") {
        for (const partPath of ["expectedOrganizationId", "expectedUserId"]) {
          expect(leaf.flags).toContainEqual(
            expect.objectContaining({
              part: "query",
              partPath,
              required: false,
            }),
          );
        }
      }
      if (action === "delete") {
        expect(leaf.flags).toContainEqual(
          expect.objectContaining({
            part: "params",
            partPath: "entryId",
            required: true,
          }),
        );
      }
    }
  });
});
