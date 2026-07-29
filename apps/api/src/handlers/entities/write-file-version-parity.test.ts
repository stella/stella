import { describe, expect, test } from "bun:test";

const readApiSource = async (relativePath: string): Promise<string> =>
  await Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();

describe("entity-version persistence parity", () => {
  test("every byte transport delegates to the shared version transaction", async () => {
    const [multipart, presigned, templates, templatePersistence] =
      await Promise.all([
        readApiSource("handlers/entities/upload-version.ts"),
        readApiSource("handlers/uploads/entity-version.ts"),
        readApiSource("mcp/template-tools.ts"),
        readApiSource("mcp/template-persistence.ts"),
      ]);

    expect(multipart).toContain("createEntityVersionFromBuffer");
    expect(presigned).toContain("writeFileVersion");
    expect(templates).toContain("persistFilledTemplateVersion");
    expect(templatePersistence).toContain("createEntityVersionFromBuffer");

    for (const transport of [
      multipart,
      presigned,
      templates,
      templatePersistence,
    ]) {
      expect(transport).not.toContain("cloneFieldsForRevision");
      expect(transport).not.toContain("nextEntityVersionNumber");
    }
  });

  test("the shared transaction retains the versioning and audit invariants", async () => {
    const core = await readApiSource("handlers/entities/write-file-version.ts");

    expect(core).toContain('.for("update")');
    expect(core).toContain("nextEntityVersionNumber");
    expect(core).toContain("cloneFieldsForRevision");
    expect(core).toContain("cellMetadata");
    expect(core).toContain("ENTITY_VERSION");
    expect(core).toContain("AUDIT_RESOURCE_TYPE.ENTITY");
    expect(core).toContain("entity-read-only");
  });
});
