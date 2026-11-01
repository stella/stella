import { expect, test } from "bun:test";

import registry from "../src/generated/registry-snapshot.json";
import { generatedRouteMap } from "../src/generated/route-map";
import reference from "../src/generated/tool-reference.json";
import { projectToolReference } from "./generate-tool-reference";

test("committed tool documentation describes the complete current CLI tree", () => {
  const rows = projectToolReference(generatedRouteMap, registry);
  expect(reference).toEqual(rows);
  expect(rows.some(({ name }) => name.startsWith("capability:"))).toBe(true);
  expect(rows.some(({ name }) => !name.startsWith("capability:"))).toBe(true);
});
