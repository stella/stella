import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extractDocxText } from "@stll/anonymize-docx";
import { inspectPdf } from "@stll/anonymize-pdf";
import { strToU8, zipSync } from "fflate";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  link as createHardLink,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  LocalAnonymizeService,
  PathScope,
  createAnonymizeMcpServer,
} from "../local";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const writeDocx = async (path: string, body: string): Promise<void> => {
  await writeFile(
    path,
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId1" Type="${OFFICE_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
      ),
    }),
  );
};

const packageVersion = (): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new TypeError("MCP package version is unavailable");
  }
  return manifest.version;
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "stella-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

type ExternalOffsetUnit =
  | "unicode-code-point"
  | "utf16-code-unit"
  | "utf8-byte";

const externalBatch = (
  document: Uint8Array,
  {
    offsetUnit = "unicode-code-point",
    start = 1,
    end = 7,
  }: { offsetUnit?: ExternalOffsetUnit; start?: number; end?: number } = {},
) => ({
  version: 1,
  document: {
    sha256: createHash("sha256").update(document).digest("hex"),
  },
  offsetUnit,
  provider: {
    id: "fake-provider",
    name: "Deterministic fake provider",
    version: "1.0.0",
  },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [
    {
      id: "fake-person-1",
      start,
      end,
      label: "PER",
      score: 0.99,
    },
  ],
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PathScope", () => {
  test("allows regular files and new outputs only inside canonical roots", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const input = join(root, "input.txt");
    const existing = join(root, "existing.txt");
    const dotDotDirectory = join(root, "..fixtures");
    const dotDotInput = join(dotDotDirectory, "input.txt");
    await mkdir(dotDotDirectory);
    await writeFile(input, "Alice");
    await writeFile(existing, "occupied");
    await writeFile(dotDotInput, "Bob");
    const scope = await PathScope.create([root]);

    const scopedInput = await scope.readInput({
      path: input,
      extension: ".txt",
      maximumBytes: 1024,
      label: "Text",
    });
    expect(scopedInput.path).toBe(await realpath(input));
    expect(new TextDecoder().decode(scopedInput.bytes)).toBe("Alice");
    await expect(
      scope.readInput({
        path: input,
        extension: ".txt",
        maximumBytes: 4,
        label: "Text",
      }),
    ).rejects.toThrow("must not exceed");
    expect((await scope.output(join(root, "output.txt"), ".txt")).path).toBe(
      join(root, "output.txt"),
    );
    expect(
      (
        await scope.readInput({
          path: dotDotInput,
          extension: ".txt",
          maximumBytes: 1024,
          label: "Text",
        })
      ).path,
    ).toBe(await realpath(dotDotInput));
    expect(
      (await scope.output(join(dotDotDirectory, "output.txt"), ".txt")).path,
    ).toBe(join(dotDotDirectory, "output.txt"));
    await expect(scope.output(existing, ".txt")).rejects.toThrow(
      "already exists",
    );
    await expect(
      scope.readInput({
        path: join(outside, "missing.txt"),
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow();
  });

  test("rejects a symlink that escapes an allowed root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = join(outside, "secret.txt");
    const link = join(root, "linked.txt");
    const insideTarget = join(root, "inside.txt");
    const insideLink = join(root, "inside-linked.txt");
    await writeFile(target, "secret");
    await writeFile(insideTarget, "inside");
    await symlink(target, link);
    await symlink(insideTarget, insideLink);
    const scope = await PathScope.create([root]);
    await expect(
      scope.readInput({
        path: link,
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow("outside the configured roots");
    await expect(
      scope.readInput({
        path: insideLink,
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow();
    const linkedDirectory = join(root, "linked-directory");
    await symlink(outside, linkedDirectory);
    await expect(
      scope.output(join(linkedDirectory, "output.txt"), ".txt"),
    ).rejects.toThrow("outside the configured roots");
  });

  test("rejects publication when the validated output directory is replaced", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const directory = join(root, "output-directory");
    const movedDirectory = join(root, "moved-output-directory");
    const outputPath = join(directory, "output.txt");
    await mkdir(directory);
    const scope = await PathScope.create([root]);
    const output = await scope.output(outputPath, ".txt");

    await rename(directory, movedDirectory);
    await symlink(outside, directory);
    await expect(output.write("sensitive output")).rejects.toThrow(
      "Output directory changed",
    );
    await expect(readFile(join(outside, "output.txt"))).rejects.toThrow();
    await expect(
      readFile(join(movedDirectory, "output.txt")),
    ).rejects.toThrow();
  });

  test("rejects FIFO inputs without waiting for a writer", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await temporaryDirectory();
    const fifo = join(root, "blocking.txt");
    await execFileAsync("mkfifo", [fifo]);
    const scope = await PathScope.create([root]);

    await expect(
      scope.readInput({
        path: fifo,
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow("regular file");
  });
});

describe("local MCP surface", () => {
  test("anonymizes and restores text without returning file contents", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input.txt");
    const anonymized = join(root, "anonymized.txt");
    const restored = join(root, "restored.txt");
    await writeFile(input, "Alice Smith signed.");
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    const anonymizeResult = await service.anonymizeText({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_case_1",
      language: "en",
    });
    expect(anonymizeResult).toMatchObject({
      operation: "anonymize",
      outputCreated: true,
      sessionId: "local_case_1",
    });
    expect(JSON.stringify(anonymizeResult)).not.toContain("Alice");
    expect(await readFile(anonymized, "utf8")).not.toBe("Alice Smith signed.");
    expect((await stat(anonymized)).mode & 0o777).toBe(0o600);
    await expect(
      service.anonymizeText({
        inputPath: input,
        outputPath: join(root, "language-mismatch.txt"),
        sessionId: "local_case_1",
        language: "de",
      }),
    ).rejects.toThrow("cannot change language");

    const restoreResult = await service.restoreText({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_case_1",
    });
    expect(restoreResult.operation).toBe("restore");
    expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
  });

  test("ingests provider-neutral Unicode sidecars and retains native detections", async () => {
    const root = await temporaryDirectory();
    const original = "😀XQZ-秘密 and alice@example.com signed.";
    const document = new TextEncoder().encode(original);
    const input = join(root, "external-input.txt");
    await writeFile(input, document);
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    const units: readonly [ExternalOffsetUnit, number, number][] = [
      ["unicode-code-point", 1, 7],
      ["utf16-code-unit", 2, 8],
      ["utf8-byte", 4, 14],
    ];

    for (const [index, [offsetUnit, start, end]] of units.entries()) {
      const batchPath = join(root, `external-${index}.json`);
      const output = join(root, `external-${index}.txt`);
      const restored = join(root, `external-restored-${index}.txt`);
      await writeFile(
        batchPath,
        JSON.stringify(externalBatch(document, { offsetUnit, start, end })),
      );
      const result = await service.anonymizeTextWithExternalDetections({
        inputPath: input,
        detectionBatchPath: batchPath,
        outputPath: output,
        sessionId: `external_unicode_${index}`,
        language: "en",
      });
      expect(result).toEqual({
        operation: "anonymize",
        format: "text",
        outputCreated: true,
        sessionId: `external_unicode_${index}`,
        entityCount: 2,
        externalDetectionBatchStatus: "accepted",
        externalDetectionCount: 1,
        retainedExternalDetectionCount: 1,
      });
      expect(JSON.stringify(result)).not.toContain("fake-provider");
      const redacted = await readFile(output, "utf8");
      expect(redacted).not.toContain("XQZ-秘密");
      expect(redacted).not.toContain("alice@example.com");
      await service.restoreText({
        inputPath: output,
        outputPath: restored,
        sessionId: `external_unicode_${index}`,
      });
      expect(await readFile(restored, "utf8")).toBe(original);
    }
  });

  test("rejects stale, open-schema, and invalid-boundary sidecars without output", async () => {
    const root = await temporaryDirectory();
    const document = new TextEncoder().encode("😀XQZ-秘密 signed.");
    const input = join(root, "invalid-external-input.txt");
    await writeFile(input, document);
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    const invalidBatches = [
      {
        name: "stale",
        batch: {
          ...externalBatch(document),
          document: { sha256: "0".repeat(64) },
        },
      },
      {
        name: "unknown",
        batch: { ...externalBatch(document), unknownProviderPayload: true },
      },
      {
        name: "boundary",
        batch: externalBatch(document, {
          offsetUnit: "utf8-byte",
          start: 1,
          end: 14,
        }),
      },
    ] as const;
    for (const invalid of invalidBatches) {
      const batchPath = join(root, `${invalid.name}.json`);
      const output = join(root, `${invalid.name}-output.txt`);
      await writeFile(batchPath, JSON.stringify(invalid.batch));
      await expect(
        service.anonymizeTextWithExternalDetections({
          inputPath: input,
          detectionBatchPath: batchPath,
          outputPath: output,
          sessionId: `invalid_external_${invalid.name}`,
        }),
      ).rejects.toThrow("The external detection batch was rejected.");
      await expect(readFile(output)).rejects.toThrow();
    }
  });

  test("bounds and scopes external sidecars and rejects path collisions", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const document = new TextEncoder().encode("😀XQZ-秘密 signed.");
    const input = join(root, "scoped-external-input.txt");
    const outsideBatch = join(outside, "outside.json");
    const linkedBatch = join(root, "linked.json");
    const oversizedBatch = join(root, "oversized.json");
    const collisionBatch = join(root, "collision.json");
    const collisionOutput = join(root, "collision.txt");
    await writeFile(input, document);
    await writeFile(outsideBatch, JSON.stringify(externalBatch(document)));
    await symlink(outsideBatch, linkedBatch);
    await writeFile(oversizedBatch, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await writeFile(collisionBatch, JSON.stringify(externalBatch(document)));
    await createHardLink(collisionBatch, collisionOutput);
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    for (const [index, batchPath] of [
      outsideBatch,
      linkedBatch,
      oversizedBatch,
    ].entries()) {
      const output = join(root, `scoped-${index}.txt`);
      await expect(
        service.anonymizeTextWithExternalDetections({
          inputPath: input,
          detectionBatchPath: batchPath,
          outputPath: output,
          sessionId: `scoped_external_${index}`,
        }),
      ).rejects.toThrow("The external detection request paths were rejected.");
      await expect(readFile(output)).rejects.toThrow();
    }
    await expect(
      service.anonymizeTextWithExternalDetections({
        inputPath: input,
        detectionBatchPath: collisionBatch,
        outputPath: collisionOutput,
        sessionId: "external_path_collision_1",
      }),
    ).rejects.toThrow("The external detection request paths were rejected.");
    expect(await readFile(collisionBatch, "utf8")).toContain("fake-provider");
    expect(await readFile(collisionOutput, "utf8")).toContain("fake-provider");
  });

  test("rejects invalid UTF-8 without creating an output", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "invalid.txt");
    const output = join(root, "output.txt");
    await writeFile(input, new Uint8Array([0xc3, 0x28]));
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    await expect(
      service.anonymizeText({
        inputPath: input,
        outputPath: output,
        sessionId: "invalid_utf8_1",
        language: "en",
      }),
    ).rejects.toThrow("valid UTF-8");
    await expect(readFile(output)).rejects.toThrow();
  });

  test("rolls back an existing session when output publication fails", async () => {
    const root = await temporaryDirectory();
    const firstInput = join(root, "first.txt");
    const firstOutput = join(root, "first-output.txt");
    const failedInput = join(root, "failed.txt");
    const tooLongTemporary = join(root, `${"x".repeat(240)}.txt`);
    const probeInput = join(root, "probe.txt");
    const probeOutput = join(root, "probe-output.txt");
    const recoveredOutput = join(root, "recovered.txt");
    await writeFile(firstInput, "Alice Smith signed.");
    await writeFile(failedInput, "Bob Jones signed.");
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    await service.anonymizeText({
      inputPath: firstInput,
      outputPath: firstOutput,
      sessionId: "rollback_case_1",
      language: "en",
    });

    await expect(
      service.anonymizeText({
        inputPath: failedInput,
        outputPath: tooLongTemporary,
        sessionId: "rollback_case_1",
      }),
    ).rejects.toThrow();
    const predictedPlaceholder = "[PERSON_rollback%5Fcase%5F1_2]";
    await writeFile(probeInput, predictedPlaceholder);
    await expect(
      service.restoreText({
        inputPath: probeInput,
        outputPath: probeOutput,
        sessionId: "rollback_case_1",
      }),
    ).rejects.toThrow("unknown session placeholder");
    await expect(readFile(probeOutput)).rejects.toThrow();
    await service.restoreText({
      inputPath: firstOutput,
      outputPath: recoveredOutput,
      sessionId: "rollback_case_1",
    });
    expect(await readFile(recoveredOutput, "utf8")).toBe("Alice Smith signed.");
  });

  test("isolates concurrent external mutations and rolls back failed publication", async () => {
    const root = await temporaryDirectory();
    const documents = [
      new TextEncoder().encode("😀XQZ-秘密 signed."),
      new TextEncoder().encode("😀QRS-秘密 signed."),
    ] as const;
    const inputs = [join(root, "external-a.txt"), join(root, "external-b.txt")];
    const batches = [
      join(root, "external-a.json"),
      join(root, "external-b.json"),
    ];
    const outputs = [
      join(root, "external-a-output.txt"),
      join(root, "external-b-output.txt"),
    ];
    for (const index of [0, 1] as const) {
      await writeFile(inputs[index], documents[index]);
      await writeFile(
        batches[index],
        JSON.stringify(externalBatch(documents[index])),
      );
    }
    let failPublication = false;
    let holdFirstPublication = true;
    let releaseFirstPublication = (): void => undefined;
    const firstPublicationReleased = new Promise<void>((resolvePromise) => {
      releaseFirstPublication = resolvePromise;
    });
    let markFirstPublicationReached = (): void => undefined;
    const firstPublicationReached = new Promise<void>((resolvePromise) => {
      markFirstPublicationReached = resolvePromise;
    });
    const service = new LocalAnonymizeService(await PathScope.create([root]), {
      faults: {
        beforeOutputPublish: async () => {
          if (failPublication) {
            throw new Error("injected external output failure");
          }
          if (holdFirstPublication) {
            holdFirstPublication = false;
            markFirstPublicationReached();
            await firstPublicationReleased;
          }
        },
      },
    });
    const first = service.anonymizeTextWithExternalDetections({
      inputPath: inputs[0],
      detectionBatchPath: batches[0],
      outputPath: outputs[0],
      sessionId: "external_concurrent_1",
      language: "en",
    });
    await firstPublicationReached;
    try {
      await expect(
        service.anonymizeTextWithExternalDetections({
          inputPath: inputs[1],
          detectionBatchPath: batches[1],
          outputPath: outputs[1],
          sessionId: "external_concurrent_1",
          language: "en",
        }),
      ).rejects.toThrow("The external detection session was rejected.");
    } finally {
      releaseFirstPublication();
    }
    await expect(first).resolves.toMatchObject({ outputCreated: true });
    const successfulIndex = 0;

    failPublication = true;
    const failedOutput = join(root, "external-failed-output.txt");
    await expect(
      service.anonymizeTextWithExternalDetections({
        inputPath: inputs[1 - successfulIndex],
        detectionBatchPath: batches[1 - successfulIndex],
        outputPath: failedOutput,
        sessionId: "external_concurrent_1",
      }),
    ).rejects.toThrow("The external detection operation failed safely.");
    await expect(readFile(failedOutput)).rejects.toThrow();
    failPublication = false;

    const restored = join(root, "external-concurrent-restored.txt");
    await service.restoreText({
      inputPath: outputs[successfulIndex],
      outputPath: restored,
      sessionId: "external_concurrent_1",
    });
    expect(await readFile(restored)).toEqual(
      Buffer.from(documents[successfulIndex]),
    );
    const predicted = join(root, "external-predicted.txt");
    const predictedOutput = join(root, "external-predicted-output.txt");
    await writeFile(predicted, "[PERSON_external%5Fconcurrent%5F1_2]");
    await expect(
      service.restoreText({
        inputPath: predicted,
        outputPath: predictedOutput,
        sessionId: "external_concurrent_1",
      }),
    ).rejects.toThrow("unknown session placeholder");
  });

  test("anonymizes and restores DOCX through path-only operations", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input.docx");
    const anonymized = join(root, "anonymized.docx");
    const restored = join(root, "restored.docx");
    await writeDocx(
      input,
      "<w:p><w:r><w:t>Alice Smith signed.</w:t></w:r></w:p>",
    );
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    const anonymizeResult = await service.anonymizeDocx({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_docx_1",
      language: "en",
      allowPartialCoverage: false,
    });
    expect(anonymizeResult.coverageStatus).toBe("full");
    expect(
      extractDocxText(await readFile(anonymized)).blocks.at(0)?.text,
    ).not.toBe("Alice Smith signed.");

    await service.restoreDocx({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_docx_1",
      allowPartialCoverage: false,
    });
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.",
    );
  });

  test("serializes raster PDF paths with server-configured executables", async () => {
    const root = await temporaryDirectory();
    const inputs = [join(root, "input-1.pdf"), join(root, "input-2.pdf")];
    const outputs = [join(root, "output-1.pdf"), join(root, "output-2.pdf")];
    const ocrLock = join(root, "ocr.lock");
    const fixture = readFileSync(
      join(
        import.meta.dir,
        "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text.pdf",
      ),
    );
    await Promise.all(inputs.map((input) => writeFile(input, fixture)));
    const executable = async (name: string, body: string): Promise<string> => {
      const path = join(root, name);
      await writeFile(path, `#!/usr/bin/env node\n${body}`, {
        flag: "wx",
        mode: 0o700,
      });
      await chmod(path, 0o700);
      return path;
    };
    const pdftoppmPath = await executable(
      "pdftoppm-test",
      `
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftoppm version 1.2.3\\n");
  process.exit(0);
}
if (!args.includes("-singlefile")) process.exit(2);
writeFileSync(args.at(-1) + ".ppm", Buffer.concat([
  Buffer.from("P6\\n612 792\\n255\\n"),
  Buffer.alloc(612 * 792 * 3, 255),
]));
`,
    );
    const tesseractPath = await executable(
      "tesseract-test",
      `
const { closeSync, openSync, unlinkSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("tesseract 5.4.1\\n");
  process.exit(0);
}
let lock;
try {
  lock = openSync(${JSON.stringify(ocrLock)}, "wx");
} catch {
  process.stderr.write("concurrent OCR process");
  process.exit(9);
}
try {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.stdout.write("level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n");
  process.stdout.write("5\\t1\\t1\\t1\\t1\\t1\\t72\\t80\\t36\\t12\\t99\\tAlice\\n");
} finally {
  closeSync(lock);
  unlinkSync(${JSON.stringify(ocrLock)});
}
`,
    );
    const service = new LocalAnonymizeService(await PathScope.create([root]), {
      pdfProvider: { pdftoppmPath, tesseractPath },
    });

    const audits = await Promise.all(
      inputs.map((inputPath, index) =>
        service.anonymizePdf({
          inputPath,
          outputPath: outputs[index] ?? "",
          ocrLanguage: "eng",
          dpi: 72,
          timeoutMs: 10_000,
          fillRgb: [0, 0, 0],
        }),
      ),
    );

    for (const [index, audit] of audits.entries()) {
      expect(audit).toMatchObject({
        operation: "anonymize",
        format: "pdf",
        outputCreated: true,
        pageCount: 1,
        entityCount: 1,
        mappedRegionCount: 1,
        structurePixelRewriteVerified: true,
        piiCleanGuaranteed: false,
      });
      expect(JSON.stringify(audit)).not.toContain("Alice");
      const output = outputs[index] ?? "";
      expect(inspectPdf(await readFile(output)).risks).toMatchObject({
        annotationCount: 0,
        embeddedFileCount: 0,
        imageObjectCount: 1,
        metadataStreamCount: 0,
      });
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }
  });

  test("reports and fails closed on partial DOCX coverage", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "partial.docx");
    const rejectedAnonymized = join(root, "partial-rejected-anonymized.docx");
    const anonymized = join(root, "partial-anonymized.docx");
    const rejectedRestore = join(root, "partial-rejected.docx");
    const restored = join(root, "partial-restored.docx");
    await writeDocx(
      input,
      "<w:p><w:r><w:t>Alice Smith signed.</w:t></w:r><w:hyperlink><w:r><w:t>Linked Name</w:t></w:r></w:hyperlink></w:p>",
    );
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    expect((await service.inspectDocx(input)).coverageStatus).toBe("partial");
    await expect(
      service.anonymizeDocx({
        inputPath: input,
        outputPath: rejectedAnonymized,
        sessionId: "local_partial_docx_1",
        language: "de",
        allowPartialCoverage: false,
      }),
    ).rejects.toThrow("outside the fully supported");
    await expect(readFile(rejectedAnonymized)).rejects.toThrow();
    const anonymizeResult = await service.anonymizeDocx({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_partial_docx_1",
      language: "en",
      allowPartialCoverage: true,
    });
    expect(anonymizeResult.coverageStatus).toBe("partial");
    await expect(
      service.restoreDocx({
        inputPath: anonymized,
        outputPath: rejectedRestore,
        sessionId: "local_partial_docx_1",
        allowPartialCoverage: false,
      }),
    ).rejects.toThrow("partial coverage");
    await expect(readFile(rejectedRestore)).rejects.toThrow();

    const restoreResult = await service.restoreDocx({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_partial_docx_1",
      allowPartialCoverage: true,
    });
    expect(restoreResult.coverageStatus).toBe("partial");
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.Linked Name",
    );
  });

  test("registers only path-oriented tools", async () => {
    const root = await temporaryDirectory();
    const scope = await PathScope.create([root]);
    const server = createAnonymizeMcpServer(new LocalAnonymizeService(scope));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    expect(client.getServerVersion()?.version).toBe(packageVersion());
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).toSorted()).toEqual([
      "anonymize_docx_file",
      "anonymize_pdf_file",
      "anonymize_text_file",
      "anonymize_text_file_with_external_detections",
      "capabilities",
      "inspect_docx_file",
      "restore_docx_file",
      "restore_text_file",
      "send_feedback",
    ]);
    for (const tool of tools.tools) {
      const properties = tool.inputSchema.properties ?? {};
      expect(properties).not.toHaveProperty("text");
      expect(properties).not.toHaveProperty("document");
      expect(properties).not.toHaveProperty("mapping");
      expect(properties).not.toHaveProperty("pdftoppmPath");
      expect(properties).not.toHaveProperty("tesseractPath");
    }
    const capabilities = await client.callTool({
      name: "capabilities",
      arguments: {},
    });
    expect(capabilities.structuredContent).toMatchObject({
      runtimeVersion: packageVersion(),
      mcp: {
        externalDetectionBatch: { ingestion: "path-only", version: 1 },
        formats: ["docx", "pdf", "text"],
        sessionMode: "memory",
        transport: "stdio",
      },
    });
    expect(JSON.stringify(capabilities)).not.toContain("redactionMap");
    expect(JSON.stringify(capabilities)).not.toContain("providerPayload");
    expect(JSON.stringify(capabilities)).not.toContain("fake-provider");

    const document = new TextEncoder().encode("😀XQZ-秘密 signed.");
    const input = join(root, "tool-external-input.txt");
    const batch = join(root, "tool-external.json");
    const output = join(root, "tool-external-output.txt");
    await writeFile(input, document);
    await writeFile(batch, JSON.stringify(externalBatch(document)));
    const externalResult = await client.callTool({
      name: "anonymize_text_file_with_external_detections",
      arguments: {
        inputPath: input,
        detectionBatchPath: batch,
        outputPath: output,
        sessionId: "external_tool_1",
        language: "en",
      },
    });
    expect(externalResult.structuredContent).toMatchObject({
      externalDetectionBatchStatus: "accepted",
      externalDetectionCount: 1,
      retainedExternalDetectionCount: 1,
      outputCreated: true,
    });
    expect(JSON.stringify(externalResult)).not.toContain("XQZ-秘密");
    expect(JSON.stringify(externalResult)).not.toContain("fake-provider");

    const secretField = "SYNTHETIC_SECRET_FIELD";
    const secretLabel = "SYNTHETIC_SECRET_LABEL";
    const secretProvider = "SYNTHETIC_SECRET_PROVIDER";
    const secretDocument = "SYNTHETIC_SECRET_DOCUMENT";
    const secretPath = "SYNTHETIC_SECRET_PATH";
    const invalidInput = join(root, `${secretPath}.txt`);
    await writeFile(invalidInput, secretDocument);
    const invalidDocument = new TextEncoder().encode(secretDocument);
    const invalidBatches = [
      {
        path: join(root, `${secretPath}-field.json`),
        value: JSON.stringify({
          ...externalBatch(invalidDocument),
          [secretField]: true,
        }),
      },
      {
        path: join(root, `${secretPath}-label.json`),
        value: JSON.stringify({
          ...externalBatch(invalidDocument),
          provider: {
            id: secretProvider,
            name: secretProvider,
            version: "1.0.0",
          },
          detections: [
            {
              id: "synthetic-detection",
              start: 0,
              end: 1,
              label: secretLabel,
              score: 0.99,
            },
          ],
        }),
      },
      {
        path: join(root, `${secretPath}-json.json`),
        value: `{"${secretField}":`,
      },
    ] as const;
    const consoleError = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      for (const [index, invalid] of invalidBatches.entries()) {
        await writeFile(invalid.path, invalid.value);
        const failure = await client.callTool({
          name: "anonymize_text_file_with_external_detections",
          arguments: {
            inputPath: invalidInput,
            detectionBatchPath: invalid.path,
            outputPath: join(root, `${secretPath}-output-${index}.txt`),
            sessionId: `external_tool_failure_${index}`,
          },
        });
        const batchEnvelope = {
          error: {
            code: "validation_error",
            message: "The external detection batch was rejected.",
            hint: "Fix the ExternalDetectionBatch v1 sidecar to match the schema and retry.",
            retryable: false,
          },
        };
        expect(failure).toEqual({
          isError: true,
          content: [{ type: "text", text: JSON.stringify(batchEnvelope) }],
          structuredContent: batchEnvelope,
        });
        const serialized = JSON.stringify(failure);
        for (const secret of [
          secretField,
          secretLabel,
          secretProvider,
          secretDocument,
          secretPath,
        ]) {
          expect(serialized).not.toContain(secret);
        }
      }
      const missingPathFailure = await client.callTool({
        name: "anonymize_text_file_with_external_detections",
        arguments: {
          inputPath: invalidInput,
          detectionBatchPath: join(root, `${secretPath}-missing.json`),
          outputPath: join(root, `${secretPath}-missing-output.txt`),
          sessionId: "external_tool_path_failure",
        },
      });
      const inputEnvelope = {
        error: {
          code: "validation_error",
          message: "The external detection request paths were rejected.",
          hint: "Use distinct absolute paths inside a configured --root for input, sidecar, and output.",
          retryable: false,
        },
      };
      expect(missingPathFailure).toEqual({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(inputEnvelope) }],
        structuredContent: inputEnvelope,
      });
      expect(JSON.stringify(missingPathFailure)).not.toContain(secretPath);
      expect(consoleError).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      stderrWrite.mockRestore();
    }
    await client.close();
  });
});
