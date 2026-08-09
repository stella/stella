import { describe, expect, test } from "bun:test";
import path from "node:path";

import { REVIEWED_VERSION_MUTATION_OWNERS } from "@/api/lib/entity-versions/version-write-ownership-policy";

const API_SOURCE_ROOT = path.resolve(import.meta.dir, "../..");

const FILE_VERSION_PERSISTENCE_PATHS = {
  bufferConsumers: [
    "handlers/chat/tools/edit-workspace-document-tools.ts",
    "handlers/entities/upload-version.ts",
    "mcp/template-persistence.ts",
  ],
  directTransactionConsumers: [
    "handlers/uploads/entity-version.ts",
    "lib/entity-versions/create-entity-version-from-buffer.ts",
  ],
  specializedTransactionOwners: [
    "handlers/entities/finalize-desktop-edit-session.ts",
    "handlers/entities/restore-version.ts",
    "handlers/folio-collab/finalize.ts",
    "lib/entity-versions/write-file-version.ts",
  ],
} as const;

const productionSourcePaths = [
  ...new Bun.Glob("**/*.ts").scanSync({
    cwd: API_SOURCE_ROOT,
    onlyFiles: true,
  }),
]
  .filter(
    (sourcePath) =>
      !sourcePath.endsWith(".test.ts") && !sourcePath.startsWith("tests/"),
  )
  .sort();

const readApiSource = async (relativePath: string): Promise<string> =>
  await Bun.file(path.join(API_SOURCE_ROOT, relativePath)).text();

const findImporters = async (moduleSpecifier: string): Promise<string[]> => {
  const sources = await Promise.all(
    productionSourcePaths.map(async (sourcePath) => ({
      sourcePath,
      source: await readApiSource(sourcePath),
    })),
  );
  return sources
    .filter(({ source }) => source.includes(`from "${moduleSpecifier}"`))
    .map(({ sourcePath }) => sourcePath);
};

describe("entity-version persistence ownership", () => {
  test("keeps every reviewed direct mutation owner attached to a production source", () => {
    const declaredOwners = Object.keys(REVIEWED_VERSION_MUTATION_OWNERS).sort();
    expect(declaredOwners).toEqual(
      productionSourcePaths
        .filter((sourcePath) => sourcePath in REVIEWED_VERSION_MUTATION_OWNERS)
        .sort(),
    );
  });

  test("binds every ordinary byte transport to a declared persistence boundary", async () => {
    const [bufferConsumers, directTransactionConsumers] = await Promise.all([
      findImporters(
        "@/api/lib/entity-versions/create-entity-version-from-buffer",
      ),
      findImporters("@/api/lib/entity-versions/write-file-version"),
    ]);

    expect(bufferConsumers).toEqual([
      ...FILE_VERSION_PERSISTENCE_PATHS.bufferConsumers,
    ]);
    expect(directTransactionConsumers).toEqual([
      ...FILE_VERSION_PERSISTENCE_PATHS.directTransactionConsumers,
    ]);

    const [multipart, presigned, automaticEdit, templatePersistence] =
      await Promise.all([
        readApiSource("handlers/entities/upload-version.ts"),
        readApiSource("handlers/uploads/entity-version.ts"),
        readApiSource("handlers/chat/tools/edit-workspace-document-tools.ts"),
        readApiSource("mcp/template-tools.ts"),
      ]);
    expect(multipart).toContain('type: "replace-current-file"');
    expect(presigned).toContain('type: "replace-current-file"');
    expect(templatePersistence).toContain('type: "replace-current-file"');
    expect(automaticEdit).toContain('type: "automatic-docx-edit"');
  });

  test("keeps specialized inline version lifecycles explicit", async () => {
    const versionUtilityConsumers = await findImporters(
      "@/api/lib/entity-versions/version-utils",
    );

    expect(versionUtilityConsumers).toEqual([
      ...FILE_VERSION_PERSISTENCE_PATHS.specializedTransactionOwners,
    ]);
  });

  test("retains durable storage and automatic-edit invariants", async () => {
    const [bufferWriter, transactionWriter] = await Promise.all([
      readApiSource("lib/entity-versions/create-entity-version-from-buffer.ts"),
      readApiSource("lib/entity-versions/write-file-version.ts"),
    ]);

    expect(
      bufferWriter.indexOf("const intent = await reserveBufferIntent"),
    ).toBeLessThan(bufferWriter.indexOf("await putS3ObjectWithSignal"));
    expect(bufferWriter).toContain("startBufferIntentHeartbeat");
    expect(bufferWriter).toContain("abandonBufferIntent");
    expect(transactionWriter).toContain('type: "automatic-docx-edit"');
    expect(transactionWriter).toContain("lockDocxEditTarget");
    expect(transactionWriter).toContain("liveDesktopEditSessionPredicates");
    expect(transactionWriter).toContain("isFolioCollabSessionExpired");
    expect(transactionWriter).toContain("expectedCurrentVersionId");
    expect(transactionWriter).toContain("replacedFileFieldId");
    expect(transactionWriter).toContain("fileChatThreads");
    expect(transactionWriter).toContain('.for("update")');
    expect(transactionWriter).toContain("nextEntityVersionNumber");
    expect(transactionWriter).toContain("cloneFieldsForRevision");
    expect(transactionWriter).toContain("cellMetadata");
    expect(transactionWriter).toContain("AUDIT_RESOURCE_TYPE.ENTITY_VERSION");
    expect(transactionWriter).toContain("deletedAt: { isNull: true }");
  });
});
