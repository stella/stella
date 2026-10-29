import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import {
  buildDataExport,
  DATA_EXPORT_RECORD_BYTES_CAP,
  DataExportRecordsTooLargeError,
  planDataExport,
} from "@/api/handlers/data-exports/build-export";
import type {
  CompletedPart,
  ExportFileRef,
  ExportSource,
  FileRead,
  RecordBytes,
  SourceDocument,
  SourceMatter,
  SourceMatterSummary,
  SourceOrganizationRecords,
} from "@/api/handlers/data-exports/build-export";
import { buildDataExportJsonSchema } from "@/api/handlers/data-exports/manifest-json-schema";
import {
  dataExportManifestSchema,
  partManifestSchema,
} from "@/api/handlers/data-exports/manifest-schema";
import type { PartManifest } from "@/api/handlers/data-exports/manifest-schema";

const CREATED_AT = new Date("2026-10-01T08:00:00.000Z");
const encoder = new TextEncoder();

type FakeFile = { bytes: Uint8Array; storedSha256: string };

const fakeFile = (content: string): FakeFile => {
  const bytes = encoder.encode(content);
  return { bytes, storedSha256: sha256Hex(bytes) };
};

const emptyTable = { columns: ["id"], rows: [] };

type FakeMatter = {
  summary: SourceMatterSummary;
  matter: SourceMatter;
};

type FakeWorld = {
  matters: FakeMatter[];
  files: Map<string, FakeFile | "missing" | "failed">;
  organization: SourceOrganizationRecords;
  templateFiles: Map<string, Uint8Array>;
  recordBytes?: RecordBytes;
};

const documentWithVersions = ({
  id,
  name,
  parentId = null,
  versions,
}: {
  id: string;
  name: string;
  parentId?: string | null;
  versions: { id: string; fileId: string; file: FakeFile; fileName?: string }[];
}): SourceDocument => ({
  id,
  kind: "document",
  parentId,
  name,
  docSequence: 1,
  currentVersionId: versions.at(-1)?.id ?? null,
  createdAt: CREATED_AT,
  createdBy: "user-1",
  updatedAt: null,
  lastEditedBy: null,
  versions: versions.map((version, index) => ({
    id: version.id,
    versionNumber: index + 1,
    stamp: null,
    label: null,
    description: null,
    createdAt: new Date(CREATED_AT.getTime() + index * 60_000),
    createdBy: `user-${index + 1}`,
    files: [
      {
        fieldId: `field-${version.id}`,
        fileId: version.fileId,
        fileName: version.fileName ?? name,
        mimeType: "application/pdf",
        sizeBytes: version.file.bytes.byteLength,
        sha256: version.file.storedSha256,
      },
    ],
  })),
});

// Two chunks, so the streaming path is exercised across a chunk boundary.
const found = (data: Uint8Array): FileRead => ({
  type: "found",
  sizeBytes: data.byteLength,
  chunks: (async function* () {
    const middle = Math.floor(data.byteLength / 2);
    yield data.subarray(0, middle);
    yield data.subarray(middle);
  })(),
});

const fakeSource = (world: FakeWorld): ExportSource => ({
  listMatters: async () => world.matters.map((m) => m.summary),
  loadMatter: async (matterId) =>
    world.matters.find((m) => m.summary.id === matterId)?.matter ?? null,
  loadOrganizationRecords: async () => world.organization,
  measureRecords: async () =>
    world.recordBytes ?? { organizationBytes: 0, matterBytes: new Map() },
  readFile: async (ref: ExportFileRef): Promise<FileRead> => {
    if (ref.type === "template") {
      const data = world.templateFiles.get(ref.templateVersionId);
      return data === undefined ? { type: "missing" } : found(data);
    }
    const file = world.files.get(ref.fileId);
    if (file === undefined || file === "missing") {
      return { type: "missing" };
    }
    if (file === "failed") {
      return { type: "failed" };
    }
    return found(file.bytes);
  },
});

const memorySink = () => {
  const parts = new Map<string, Uint8Array[]>();
  const closed: string[] = [];
  return {
    parts,
    closed,
    sink: {
      openPart: (fileName: string) => {
        const chunks: Uint8Array[] = [];
        parts.set(fileName, chunks);
        return {
          write: async (chunk: Uint8Array) => {
            chunks.push(chunk);
          },
          close: async () => {
            closed.push(fileName);
          },
        };
      },
    },
    bytesOf: (fileName: string) => Buffer.concat(parts.get(fileName) ?? []),
  };
};

const matterFixture = ({
  id,
  name,
  documents,
  folders = [],
}: {
  id: string;
  name: string;
  documents: SourceDocument[];
  folders?: SourceMatter["folders"];
}): FakeMatter => {
  const summary = {
    id,
    name,
    reference: `REF-${id}`,
    status: "active",
    createdAt: CREATED_AT,
    estimatedBytes: documents
      .flatMap((d) => d.versions.flatMap((ver) => ver.files))
      .reduce((sum, file) => sum + file.sizeBytes, 0),
  };
  return {
    summary,
    matter: {
      summary,
      record: { id, name },
      folders,
      documents,
      tasks: {
        columns: ["id", "name"],
        rows: [{ id: `task-${id}`, name: "=SUM(A1)" }],
      },
      timeEntries: emptyTable,
      expenses: emptyTable,
      invoices: emptyTable,
    },
  };
};

const organizationFixture = (): SourceOrganizationRecords => ({
  sellerProfiles: emptyTable,
  clauseCategories: emptyTable,
  templateCategories: emptyTable,
  contacts: {
    columns: ["id", "displayName"],
    rows: [{ id: "contact-1", displayName: "Novák, s.r.o." }],
  },
  contactRelationships: emptyTable,
  clauses: emptyTable,
  templates: emptyTable,
  unassignedTimeEntries: emptyTable,
  invoices: {
    columns: ["id", "workspaceId"],
    rows: [
      {
        id: "client-invoice-1",
        workspaceId: null,
        lines: [{ id: "line-1" }],
        payments: [{ id: "payment-1" }],
      },
    ],
  },
  templateFiles: [
    {
      templateId: "tpl-1",
      templateName: "Plná moc",
      templateVersionId: "tplv-1",
      version: 1,
      fileName: "plna-moc.docx",
      sizeBytes: 4,
    },
  ],
});

type RunOptions = {
  partTargetBytes?: number;
  completedParts?: CompletedPart[];
  beforePart?: () => Promise<void>;
  source?: ExportSource;
};

const run = async (
  world: FakeWorld,
  {
    partTargetBytes = 1_000_000,
    completedParts = [],
    beforePart = async () => {},
    source = fakeSource(world),
  }: RunOptions = {},
) => {
  const memory = memorySink();
  const plan = (
    await planDataExport({
      source,
      partTargetBytes,
      recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
      scope: { versions: "all" },
    })
  ).unwrap();
  const checkpoints: CompletedPart[] = [];
  let paced = 0;
  const manifest = await buildDataExport({
    exportId: "0f1e2d3c-0000-4000-8000-000000000001",
    organization: { id: "org-1", name: "Kancelář" },
    requestedBy: "user-1",
    createdAt: CREATED_AT,
    scope: { versions: "all" },
    plan,
    completedParts,
    source,
    sink: memory.sink,
    pace: async () => {
      paced += 1;
    },
    signal: new AbortController().signal,
    beforePart,
    onPartComplete: async (part) => {
      checkpoints.push(part);
    },
    now: () => new Date("2026-10-01T09:00:00.000Z"),
  });
  if (completedParts.length > 0) {
    return {
      manifest,
      zips: [],
      partManifests: [],
      memory,
      checkpoints,
      paced,
    };
  }
  const zips = await Promise.all(
    manifest.parts.map(async (part) => {
      const bytes = memory.bytesOf(part.fileName);
      expect(bytes.byteLength).toBe(part.sizeBytes);
      expect(sha256Hex(bytes)).toBe(part.sha256);
      return await JSZip.loadAsync(bytes);
    }),
  );
  const partManifests = await Promise.all(
    zips.map(async (zip) => {
      const text = await zip.file("manifest.json")?.async("string");
      if (text === undefined) {
        throw new Error("part has no manifest.json");
      }
      return v.parse(partManifestSchema, JSON.parse(text));
    }),
  );
  return { manifest, zips, partManifests, memory, checkpoints, paced };
};

const basicWorld = (): FakeWorld => {
  const v1 = fakeFile("version one");
  const v2 = fakeFile("version two, longer");
  const v3 = fakeFile("version three");
  const other = fakeFile("other matter document");
  return {
    matters: [
      matterFixture({
        id: "m-1",
        name: "Alfa v. Beta",
        folders: [{ id: "folder-1", parentId: null, name: "Pleadings" }],
        documents: [
          documentWithVersions({
            id: "doc-1",
            name: "Žaloba.pdf",
            parentId: "folder-1",
            versions: [
              { id: "ver-1", fileId: "file-1", file: v1 },
              { id: "ver-2", fileId: "file-2", file: v2 },
              { id: "ver-3", fileId: "file-3", file: v3 },
            ],
          }),
        ],
      }),
      matterFixture({
        id: "m-2",
        name: "Gama",
        documents: [
          documentWithVersions({
            id: "doc-2",
            name: "Smlouva.pdf",
            versions: [{ id: "ver-4", fileId: "file-4", file: other }],
          }),
        ],
      }),
    ],
    files: new Map([
      ["file-1", v1],
      ["file-2", v2],
      ["file-3", v3],
      ["file-4", other],
    ]),
    organization: organizationFixture(),
    templateFiles: new Map([["tplv-1", encoder.encode("docx")]]),
  };
};

describe("organisation data export admission", () => {
  test("sizes parts by the records they carry, not only their files", async () => {
    const world = basicWorld();
    const filesOnly = (
      await planDataExport({
        source: fakeSource(world),
        partTargetBytes: 2 * 1024 ** 3,
        recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
        scope: { versions: "all" },
      })
    ).unwrap();
    const matterId = world.matters.at(0)?.summary.id ?? "";
    const withRecords = (
      await planDataExport({
        source: fakeSource({
          ...world,
          recordBytes: {
            organizationBytes: 1000,
            matterBytes: new Map([[matterId, 500]]),
          },
        }),
        partTargetBytes: 2 * 1024 ** 3,
        recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
        scope: { versions: "all" },
      })
    ).unwrap();
    expect(withRecords.bytesTotal).toBe(filesOnly.bytesTotal + 1500);
  });

  test.each(["organization", "matter"] as const)(
    "refuses an export whose records exceed the cap, here through its %s records, before loading any",
    async (unit) => {
      const world = basicWorld();
      const matterId = world.matters.at(0)?.summary.id ?? "";
      const over = DATA_EXPORT_RECORD_BYTES_CAP + 1;
      let loaded = false;
      const source: ExportSource = {
        ...fakeSource({
          ...world,
          recordBytes: {
            organizationBytes: unit === "organization" ? over : 0,
            matterBytes: new Map([[matterId, unit === "matter" ? over : 0]]),
          },
        }),
        loadOrganizationRecords: async () => {
          loaded = true;
          return world.organization;
        },
      };
      const planned = await planDataExport({
        source,
        partTargetBytes: 2 * 1024 ** 3,
        recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
        scope: { versions: "all" },
      });
      const error = planned.isErr() ? planned.error : null;
      expect(error).toBeInstanceOf(DataExportRecordsTooLargeError);
      expect(error).toMatchObject({ bytes: over });
      expect(loaded).toBe(false);
    },
  );
});

describe("organisation data export archive paths", () => {
  test("keeps a historical file and a mirrored folder of the same name apart", async () => {
    const files = new Map(
      ["r-1", "r-2", "c-1", "c-2"].map(
        (id) => [id, fakeFile(`bytes of ${id}`)] as const,
      ),
    );
    const version = (id: string) => ({
      id: `ver-${id}`,
      fileId: id,
      file: files.get(id) ?? fakeFile(id),
    });
    const world: FakeWorld = {
      ...basicWorld(),
      matters: [
        matterFixture({
          id: "m-1",
          name: "Alfa v. Beta",
          // "Report" at version 1 is named "Report (v1)" under versions/,
          // the mirrored name of this folder.
          folders: [{ id: "folder-r", parentId: null, name: "Report (v1)" }],
          documents: [
            documentWithVersions({
              id: "doc-r",
              name: "Report",
              versions: [version("r-1"), version("r-2")],
            }),
            documentWithVersions({
              id: "doc-c",
              name: "child.pdf",
              parentId: "folder-r",
              versions: [version("c-1"), version("c-2")],
            }),
          ],
        }),
      ],
      files,
    };
    const { zips } = await run(world);
    const paths = zips.flatMap((zip) =>
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name),
    );
    // No file path is also the directory of another file.
    for (const path of paths) {
      expect(
        paths.some((other) => other.startsWith(`${path}/`)),
        path,
      ).toBe(false);
    }
    expect(paths.filter((path) => path.includes("/versions/"))).toHaveLength(2);
  });
});

describe("organisation data export builder", () => {
  test("carries every document version with its verified checksum and path", async () => {
    const world = basicWorld();
    const { manifest, zips, partManifests } = await run(world);
    expect(manifest.parts).toHaveLength(1);
    const zip = zips[0];
    const part = partManifests[0];
    if (zip === undefined || part === undefined) {
      throw new Error("expected one part");
    }

    const document = part.matters
      .flatMap((m) => m.documents)
      .find((d) => d.id === "doc-1");
    expect(document?.versions.map((ver) => ver.versionNumber)).toEqual([
      1, 2, 3,
    ]);
    const files = document?.versions.flatMap((ver) => ver.files) ?? [];
    expect(files.map((f) => f.path)).toEqual([
      "matters/Alfa v. Beta [REF-m-1]/versions/Pleadings/Žaloba (v1).pdf",
      "matters/Alfa v. Beta [REF-m-1]/versions/Pleadings/Žaloba (v2).pdf",
      "matters/Alfa v. Beta [REF-m-1]/documents/Pleadings/Žaloba.pdf",
    ]);
    for (const file of files) {
      const bytes = await zip.file(file.path)?.async("uint8array");
      expect(bytes).toBeDefined();
      expect(sha256Hex(bytes ?? new Uint8Array())).toBe(file.sha256);
      expect(bytes?.byteLength).toBe(file.sizeBytes);
    }
    expect(manifest.totals).toEqual({
      matters: 2,
      documents: 2,
      versions: 4,
      files: 4,
      fileBytes: [...world.files.values()].reduce(
        (sum, f) => sum + (typeof f === "string" ? 0 : f.bytes.byteLength),
        0,
      ),
    });
    expect(manifest.problems).toEqual([]);
  });

  test("writes JSON records verbatim and CSV with neutralised formulas", async () => {
    const { zips, partManifests } = await run(basicWorld());
    const zip = zips[0];
    const tasksRef = partManifests[0]?.matters[0]?.records.tasks;
    if (
      zip === undefined ||
      tasksRef?.csv === undefined ||
      tasksRef.csv === null
    ) {
      throw new Error("expected task records");
    }
    const json = JSON.parse(
      (await zip.file(tasksRef.json)?.async("string")) ?? "",
    );
    expect(json).toEqual([{ id: "task-m-1", name: "=SUM(A1)" }]);
    const csv = (await zip.file(tasksRef.csv)?.async("string")) ?? "";
    expect(csv).toContain('"\t=SUM(A1)"');
    const invoicesRef = partManifests[0]?.organizationRecords?.invoices;
    expect(invoicesRef?.count).toBe(1);
    const invoiceJson =
      invoicesRef === undefined
        ? undefined
        : await zip.file(invoicesRef.json)?.async("string");
    expect(JSON.parse(invoiceJson ?? "null")).toEqual(
      organizationFixture().invoices.rows,
    );
    expect(
      Object.keys(zip.files).filter((path) =>
        path.endsWith("invoices-without-matter.json"),
      ),
    ).toHaveLength(1);
  });

  test("splits parts only at matter boundaries and keeps organisation records in part 1", async () => {
    const world = basicWorld();
    // Smaller than the first matter's files: every matter gets its own part.
    const { manifest, partManifests, zips } = await run(world, {
      partTargetBytes: 10,
    });
    expect(manifest.parts.map((p) => p.matterIds)).toEqual([["m-1"], ["m-2"]]);
    expect(partManifests.map((p) => p.part)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);
    expect(partManifests[0]?.organizationRecords).not.toBeNull();
    expect(partManifests[1]?.organizationRecords).toBeNull();
    for (const [index, part] of partManifests.entries()) {
      const zip = zips[index];
      for (const matter of part.matters) {
        for (const document of matter.documents) {
          for (const file of document.versions.flatMap((ver) => ver.files)) {
            expect(zip?.file(file.path)).not.toBeNull();
          }
        }
      }
      expect(part.matters.map((m) => m.id)).toEqual(
        manifest.parts[index]?.matterIds ?? [],
      );
    }
  });

  test("records the archived byte length for buffered files despite stale storage sizes", async () => {
    const world = basicWorld();
    for (const matter of world.matters) {
      for (const document of matter.matter.documents) {
        for (const version of document.versions) {
          for (const file of version.files) {
            file.mimeType = "text/plain";
          }
        }
      }
    }
    const source = fakeSource(world);
    const { zips, partManifests } = await run(world, {
      source: {
        ...source,
        readFile: async (ref) => {
          const read = await source.readFile(ref);
          return ref.type === "document" && read.type === "found"
            ? { ...read, sizeBytes: read.sizeBytes + 100 }
            : read;
        },
      },
    });
    let checkedFiles = 0;
    for (const [index, part] of partManifests.entries()) {
      for (const matter of part.matters) {
        for (const document of matter.documents) {
          for (const version of document.versions) {
            for (const file of version.files) {
              const bytes = await zips[index]
                ?.file(file.path)
                ?.async("uint8array");
              expect(bytes).toBeDefined();
              expect(bytes?.byteLength).toBe(file.sizeBytes);
              checkedFiles += 1;
            }
          }
        }
      }
    }
    expect(checkedFiles).toBeGreaterThan(0);
  });

  test("lists unreadable files as absent and corrupted files as checksum mismatches", async () => {
    const world = basicWorld();
    world.files.set("file-1", "missing");
    world.files.set("file-2", "failed");
    world.files.set("file-4", {
      bytes: encoder.encode("tampered"),
      storedSha256: "0".repeat(64),
    });
    const { manifest, zips } = await run(world);
    expect(
      manifest.problems.map((problem) =>
        problem.reason === "matter_unavailable"
          ? { matterId: problem.matterId, reason: problem.reason }
          : { fileId: problem.fileId, reason: problem.reason },
      ),
    ).toEqual([
      { fileId: "file-1", reason: "missing" },
      { fileId: "file-2", reason: "fetch_failed" },
      { fileId: "file-4", reason: "checksum_mismatch" },
    ]);
    for (const problem of manifest.problems) {
      if (problem.reason === "matter_unavailable") {
        throw new Error("no matter was planned away in this world");
      }
      const entry = zips[0]?.file(problem.path) ?? null;
      if (problem.reason === "checksum_mismatch") {
        // Shipped as stored, so the person can still inspect it.
        expect(await entry?.async("string")).toBe("tampered");
        // The checksum recorded at upload, not the one of the bytes found.
        expect(problem.recordedSha256).toBe(
          sha256Hex(encoder.encode("other matter document")),
        );
        continue;
      }
      expect(entry).toBeNull();
    }
  });

  test("resumes after the last checkpoint without rebuilding finished parts", async () => {
    const first = await run(basicWorld(), { partTargetBytes: 10 });
    expect(first.checkpoints.map((part) => part.index)).toEqual([1, 2]);
    expect(first.paced).toBeGreaterThan(0);
    const firstPart = first.checkpoints.at(0);
    if (firstPart === undefined) {
      throw new Error("expected a first part");
    }
    const resumed = await run(basicWorld(), {
      partTargetBytes: 10,
      completedParts: [firstPart],
    });
    const secondPart = first.manifest.parts.at(1);
    if (secondPart === undefined) {
      throw new Error("expected a second part");
    }
    expect([...resumed.memory.parts.keys()]).toEqual([secondPart.fileName]);
    expect(resumed.checkpoints.map((part) => part.index)).toEqual([2]);
    expect(resumed.manifest.parts.map((part) => part.sha256)).toEqual(
      first.manifest.parts.map((part) => part.sha256),
    );
    expect(resumed.manifest.totals).toEqual(first.manifest.totals);
  });

  test("stops between files when its signal aborts", async () => {
    const controller = new AbortController();
    const source = fakeSource(basicWorld());
    const plan = (
      await planDataExport({
        source,
        partTargetBytes: 10,
        recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
        scope: { versions: "all" },
      })
    ).unwrap();
    const checkpoints: CompletedPart[] = [];
    const rejection = await rejectionOf(
      buildDataExport({
        exportId: "0f1e2d3c-0000-4000-8000-000000000001",
        organization: { id: "org-1", name: "Kancelář" },
        requestedBy: "user-1",
        createdAt: CREATED_AT,
        scope: { versions: "all" },
        plan,
        completedParts: [],
        source,
        sink: memorySink().sink,
        pace: async () => {
          controller.abort();
        },
        signal: controller.signal,
        beforePart: async () => {},
        onPartComplete: async (part) => {
          checkpoints.push(part);
        },
      }),
    );
    expect(rejection).toBeInstanceOf(DOMException);
    expect(checkpoints).toEqual([]);
  });

  test("validates against the Valibot contract and the committed JSON Schema", async () => {
    const { manifest, partManifests } = await run(basicWorld(), {
      partTargetBytes: 10,
    });
    const committed: unknown = await Bun.file(
      new URL(
        "../../../../../docs/data-export/stella-data-export.v1.schema.json",
        import.meta.url,
      ),
    ).json();
    // Drift guard: the published schema is exactly what the contract derives.
    expect(committed).toEqual(buildDataExportJsonSchema());

    const ajv = new Ajv({ allowUnionTypes: true, strict: true });
    addFormats(ajv);
    const { $schema: _draft, ...schema } = buildDataExportJsonSchema();
    const validate = ajv.compile(schema);
    const documents: unknown[] = [manifest, ...partManifests];
    for (const document of documents) {
      expect(v.safeParse(dataExportManifestSchema, document).success).toBe(
        true,
      );
      expect(validate(document)).toBe(true);
    }
    const broken: PartManifest | undefined = partManifests[0];
    expect(validate({ ...broken, formatVersion: 2 })).toBe(false);
  });

  test("records a planned matter that can no longer be read instead of dropping it", async () => {
    const world = basicWorld();
    const source = fakeSource(world);
    const gone: ExportSource = {
      ...source,
      // Planned (listed) but unreadable when its part is built.
      loadMatter: async (matterId, scope) =>
        matterId === "m-2" ? null : await source.loadMatter(matterId, scope),
    };
    const { manifest } = await run(world, { source: gone });
    expect(manifest.problems).toEqual([
      { reason: "matter_unavailable", matterId: "m-2" },
    ]);
    expect(manifest.parts.flatMap((part) => part.matterIds)).toEqual(["m-1"]);
  });

  test("stops before a part when the run may no longer continue", async () => {
    const refusal = new Error("requester lost the export permission");
    const rejection = await rejectionOf(
      run(basicWorld(), {
        beforePart: async () => {
          throw refusal;
        },
      }),
    );
    expect(rejection).toBe(refusal);
  });
});
