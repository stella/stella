import { describe, expect, test } from "bun:test";

import { createRootHead } from "./-root-head";

describe("root document feature marker", () => {
  test("emits the public knowledge marker only with the flag enabled", () => {
    expect(createRootHead(true).meta).toContainEqual({
      name: "public-knowledge",
      content: "enabled",
    });
    expect(
      createRootHead(false).meta.some(
        (meta) => "name" in meta && meta.name === "public-knowledge",
      ),
    ).toBe(false);
  });
});
