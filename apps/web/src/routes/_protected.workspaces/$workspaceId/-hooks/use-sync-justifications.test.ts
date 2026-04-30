import { describe, expect, test } from "bun:test";

import { chunkJustificationEntityIds } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";

describe("chunkJustificationEntityIds", () => {
  test("deduplicates, sorts, and chunks entity ids", () => {
    const ids = [
      "entity-003",
      ...Array.from(
        { length: 205 },
        (_, index) => `entity-${String(index).padStart(3, "0")}`,
      ),
      "entity-010",
    ];

    const chunks = chunkJustificationEntityIds(ids);

    expect(chunks).toHaveLength(2);
    expect(chunks.at(0)).toHaveLength(200);
    expect(chunks.at(1)).toHaveLength(5);
    expect(chunks.at(0)?.at(0)).toBe("entity-000");
    expect(chunks.at(1)?.at(-1)).toBe("entity-204");
  });
});
