import { expect, test } from "bun:test";
import fc from "fast-check";

import { ZipArchive } from "@stll/docx-core/zip";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { DocxArchiveError, loadDocx, loadDocxArchive } from "./archive";

const part = fc.record({
  path: fc
    .integer({ min: 0, max: 10_000 })
    .map((id) => `word/parts/part-${id}.bin`),
  bytes: fc.uint8Array({ maxLength: 512 }),
});
const parts = fc.uniqueArray(part, {
  selector: ({ path }) => path,
  maxLength: 12,
});
const buildZip = async (
  entries: { path: string; bytes: Uint8Array }[],
): Promise<ArrayBuffer> => {
  const zip = new ZipArchive();
  for (const { path, bytes } of entries) {
    zip.set(path, bytes);
  }
  return (await zip.generate({ compression: "store" })).buffer;
};

const expectArchiveError = async (promise: Promise<unknown>): Promise<void> => {
  const result = await Promise.allSettled([promise]);
  const outcome = result.at(0);
  expect(outcome?.status).toBe("rejected");
  if (outcome?.status === "rejected") {
    expect(outcome.reason).toBeInstanceOf(DocxArchiveError);
    expect(outcome.reason).toMatchObject({ _tag: "DocxArchiveError" });
  }
};

test(
  "archive repacking preserves every part",
  async () => {
    await assertProperty(
      "archive repacking preserves every part",
      fc.asyncProperty(
        parts,
        fc.string({ maxLength: 256 }),
        async (entries, text) => {
          const zip = await loadDocx(await buildZip(entries));
          zip.set("word/document.xml", text);
          const first = await loadDocx(await zip.generate());
          const second = await loadDocx(await first.generate());
          expect(second.paths().toSorted()).toEqual(first.paths().toSorted());
          for (const { path, bytes } of entries) {
            const binary = await second.entry(path)?.arrayBuffer();
            expect(binary).not.toBeNull();
            expect(new Uint8Array(binary ?? new ArrayBuffer(0))).toEqual(bytes);
          }
          expect(await second.entry("word/document.xml")?.text()).toBe(text);
          expect(second.entry("word/missing.xml") ?? null).toBeNull();
        },
      ),
      { numRuns: 30 },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "archive loading applies configured budgets",
  async () => {
    await assertProperty(
      "archive loading applies configured budgets",
      fc.asyncProperty(
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 128 }),
        async (count, length) => {
          const buffer = await buildZip(
            Array.from({ length: count }, (_, id) => ({
              path: `part-${id}.bin`,
              bytes: new Uint8Array(length),
            })),
          );
          await expectArchiveError(loadDocx(buffer, { maxEntries: count - 1 }));
          await expectArchiveError(
            loadDocx(buffer, { maxEntryBytes: length - 1 }),
          );
          await expectArchiveError(
            loadDocx(buffer, { maxTotalBytes: count * length - 1 }),
          );
          const archive = await loadDocxArchive(buffer, {
            maxEntries: count,
            maxEntryBytes: length,
            maxTotalBytes: count * length,
          });
          const reads = await Promise.allSettled(
            Array.from(
              { length: count + 1 },
              async () => await archive.readEntryUint8("part-0.bin"),
            ),
          );
          expect(
            reads.slice(0, count).every(({ status }) => status === "fulfilled"),
          ).toBe(true);
          const last = reads.at(-1);
          expect(last?.status).toBe("rejected");
          if (last?.status === "rejected") {
            expect(last.reason).toBeInstanceOf(DocxArchiveError);
          }
        },
      ),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "archive loading supports representative part counts",
  async () => {
    const buffer = await buildZip(
      Array.from({ length: 4000 }, (_, id) => ({
        path: `word/part-${id}.bin`,
        bytes: new Uint8Array([id % 256]),
      })),
    );
    const zip = await loadDocx(buffer);
    expect(zip.paths()).toHaveLength(4000);
    expect(
      new Uint8Array(
        (await zip.entry("word/part-3999.bin")?.arrayBuffer()) ??
          new ArrayBuffer(0),
      ),
    ).toEqual(new Uint8Array([3999 % 256]));
  },
  propertyTestTimeout(15_000),
);

test(
  "archive loading supports representative part sizes",
  async () => {
    const image = new Uint8Array(8 * 1024 * 1024).fill(73);
    const buffer = await buildZip(
      Array.from({ length: 3 }, (_, id) => ({
        path: `word/media/image-${id}.bin`,
        bytes: image,
      })),
    );
    const zip = await loadDocx(buffer, {
      maxEntryBytes: 9 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
    });
    for (let id = 0; id < 3; id++) {
      const content = await zip
        .entry(`word/media/image-${id}.bin`)
        ?.arrayBuffer();
      expect(content?.byteLength).toBe(image.length);
      const bytes = new Uint8Array(content ?? new ArrayBuffer(0));
      expect(bytes.at(0)).toBe(73);
      expect(bytes.at(-1)).toBe(73);
    }
  },
  propertyTestTimeout(15_000),
);

test("rejects archives whose end records are ambiguous", async () => {
  const zip = new ZipArchive();
  zip.set("part.txt", "text");
  const generated = await zip.generate({ compression: "store" });
  const bytes = new Uint8Array(generated.length + 4);
  bytes.set(generated);
  new DataView(bytes.buffer).setUint16(generated.length - 2, 4, true);
  bytes.set([80, 75, 5, 6], generated.length);
  await expectArchiveError(loadDocx(bytes));
});

test("bounded reads apply entry limits to replacements", async () => {
  const archive = await loadDocxArchive(await buildZip([]), {
    maxEntryBytes: 4,
    maxTotalBytes: 16,
  });
  archive.zip.set("part.txt", "replacement");
  expect(await rejectionOf(archive.readEntryString("part.txt"))).toMatchObject({
    _tag: "DocxArchiveError",
    reason: "entry-too-large",
  });
});
