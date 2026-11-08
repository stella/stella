import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

const OPERATIONS = ["batch.create", "create", "delete", "list"] as const;
const CATALOG = path.join(
  import.meta.dir,
  "../../../../packages/cli/capabilities",
);

test("every matter-link kind has the complete MCP and CLI capability set", async () => {
  const files = (await readdir(CATALOG)).filter(
    (file) => file.includes(".matter-links.") && file.endsWith(".json"),
  );
  const ids = files.map((file) => file.slice(0, -5));
  const kinds = new Set(
    ids.map((id) => id.slice(0, id.indexOf(".matter-links."))),
  );
  expect([...kinds].toSorted()).toEqual(["case-law", "legislation"]);
  for (const kind of kinds) {
    const expected = OPERATIONS.map(
      (operation) => `${kind}.matter-links.${operation}`,
    ).toSorted();
    expect(
      ids.filter((id) => id.startsWith(`${kind}.matter-links.`)).toSorted(),
    ).toEqual(expected);
    for (const id of expected) {
      const capability = await Bun.file(
        path.join(CATALOG, `${id}.json`),
      ).json();
      expect(capability.id).toBe(id);
      expect(capability.handlerKind).toBe("workspace");
      expect(capability.mcp?.type).toBe("capability");
    }
  }
});
