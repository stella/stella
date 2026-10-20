import { describe, expect, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

describe.serial("extracted document content ownership", () => {
  const entry = OWNERSHIP.find(({ id }) => id === "extracted-content-read");
  const options = {
    ruleOptions: { entries: [entry] },
    sourcePath: "apps/api/src/lib/content-consumer.ts",
    cwd: "scratch",
  } as const;

  test("assigns content reads to the document content owner", () => {
    expect(entry?.owner).toEqual([
      "apps/api/src/lib/document-content-provenance.ts",
    ]);
    expect(entry?.enforcement).toEqual({
      kind: "table-column-read",
      specifiers: ["@/api/db/schema", "@/api/db/schema/templates"],
      table: "extractedContent",
      columns: ["ciphertext", "iv", "ocrPayloadCiphertext", "ocrPayloadIv"],
      allowed: [],
    });
  });

  test("routes payload projections and complete rows through the owner", async () => {
    const source = [
      'import { extractedContent as table } from "@/api/db/schema/templates";',
      "db.select({ ciphertext: table.ciphertext }).from(table);",
      "const local = table; const iv = local['iv'];",
      "const { ocrPayloadCiphertext } = table;",
      "db.select({ iv: table.ocrPayloadIv }).from(table);",
      "db.select().from(table);",
      "db.query.extractedContent.findFirst();",
      "db.query.entities.findFirst({ with: { extractedContent: true } });",
      "db.query.extractedContent.findMany({ columns: { ciphertext: true } });",
      "const selection = { with: { entity: { with: { extractedContent: { columns: { iv: true } } } } } }; db.query.fields.findMany(selection);",
    ].join("\n");
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      await lintSingleRule("confine-owner", source, {
        ...options,
        sourcePath: "apps/api/src/lib/document-content-provenance.ts",
      }),
    ).toEqual([]);
  });

  test("keeps metadata selection and result writes available", async () => {
    const source = [
      'import { extractedContent } from "@/api/db/schema";',
      "db.select({ entityId: extractedContent.entityId, sourceVersionId: extractedContent.sourceEntityVersionId }).from(extractedContent);",
      "db.query.extractedContent.findMany({ columns: { entityId: true, charCount: true } });",
      "db.query.entities.findFirst({ with: { extractedContent: { columns: { sourceFieldId: true } } } });",
      "db.insert(extractedContent).values({ ciphertext, iv, ocrPayloadCiphertext, ocrPayloadIv });",
      "db.update(extractedContent).set({ ciphertext, iv }).returning({ entityId: extractedContent.entityId });",
      "db.delete(extractedContent);",
      "db.query.entities.findFirst({ with: { extractedContent: false } });",
    ].join("\n");
    expect(await lintSingleRule("confine-owner", source, options)).toEqual([]);
  });
});
