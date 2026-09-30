import { expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_BYTES,
  DocxArchiveError,
  loadDocxArchive,
} from "./archive";
import { extractBinary, extractText, loadDocx, repackZip } from "./zip";

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
  const zip = new JSZip();
  for (const { path, bytes } of entries) {
    zip.file(path, bytes, { createFolders: false });
  }
  return await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
};

// Fixtures modify only the upstream-produced central directory's size field.
const withDeclaredSize = (buffer: ArrayBuffer, size: number): ArrayBuffer => {
  const bytes = new Uint8Array(buffer.slice(0));
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02_01_4b_50) {
      view.setUint32(offset + 24, size, true);
    }
  }
  return bytes.buffer;
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
    await fc.assert(
      fc.asyncProperty(
        parts,
        fc.string({ maxLength: 256 }),
        async (entries, text) => {
          const zip = await loadDocx(await buildZip(entries));
          zip.file("word/document.xml", text);
          const first = await loadDocx(await repackZip(zip));
          const second = await loadDocx(await repackZip(first));
          expect(Object.keys(second.files).toSorted()).toEqual(
            Object.keys(first.files).toSorted(),
          );
          for (const { path, bytes } of entries) {
            const binary = await extractBinary(second, path);
            expect(binary).not.toBeNull();
            expect(new Uint8Array(binary ?? new ArrayBuffer(0))).toEqual(bytes);
          }
          expect(await extractText(second, "word/document.xml")).toBe(text);
          expect(await extractText(second, "word/missing.xml")).toBeNull();
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 30 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "archive loading applies file name rules",
  async () => {
    const name = fc
      .tuple(
        fc.constantFrom("../", "word/../", "/", "C:/", "word\\", "word/../../"),
        fc.integer({ min: 0, max: 1000 }),
      )
      .map(([prefix, id]) => `${prefix}part-${id}.xml`);
    await fc.assert(
      fc.asyncProperty(name, async (path) => {
        await expectArchiveError(
          loadDocx(await buildZip([{ path, bytes: new Uint8Array([1]) }])),
        );
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 30 }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "archive loading applies configured budgets",
  async () => {
    await fc.assert(
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
            Array.from({ length: count + 1 }, () =>
              archive.readEntryUint8("part-0.bin"),
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
      propertyConfig({ seed: propertySeed(), numRuns: 20 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "archive loading keeps error and work bounds",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 2, maxLength: 256 }),
        fc.integer({ min: 1, max: 64 }),
        async (bytes, depth) => {
          const buffer = await buildZip([
            { path: `${"nested/".repeat(depth)}part.bin`, bytes },
          ]);
          const start = performance.now();
          await expectArchiveError(
            loadDocx(buffer.slice(0, buffer.byteLength - 1)),
          );
          await expectArchiveError(
            loadDocx(
              withDeclaredSize(buffer, DOCX_MAX_ENTRY_BYTES + bytes.length),
            ),
          );
          await expectArchiveError(
            loadDocx(withDeclaredSize(buffer, 1), {
              maxEntryBytes: bytes.length - 1,
            }),
          );
          const altered = new Uint8Array(buffer.slice(0));
          const view = new DataView(altered.buffer);
          const payloadOffset =
            30 + view.getUint16(26, true) + view.getUint16(28, true);
          altered[payloadOffset] = 255 - (altered[payloadOffset] ?? 0);
          const outcomes = await Promise.allSettled([loadDocx(altered)]);
          const outcome = outcomes.at(0);
          if (outcome?.status === "rejected") {
            expect(outcome.reason).toBeInstanceOf(DocxArchiveError);
          } else if (outcome?.status === "fulfilled") {
            const extracted = await extractBinary(
              outcome.value,
              `${"nested/".repeat(depth)}part.bin`,
            );
            expect(extracted?.byteLength).toBe(bytes.length);
          }
          const loaded = await loadDocx(buffer);
          expect(Object.keys(loaded.files)).toHaveLength(1);
          expect(performance.now() - start).toBeLessThan(2000);
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 20 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "archive loading applies the default entry budget",
  async () => {
    const buffer = await buildZip(
      Array.from({ length: DOCX_MAX_ENTRIES + 1 }, (_, id) => ({
        path: `part-${id}.bin`,
        bytes: new Uint8Array(0),
      })),
    );
    await expectArchiveError(loadDocx(buffer));
  },
  propertyTestTimeout(5000),
);

test(
  "archive byte inputs keep typed outcomes",
  async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 1024 }), async (bytes) => {
        const start = performance.now();
        const outcomes = await Promise.allSettled([loadDocx(bytes)]);
        const outcome = outcomes.at(0);
        if (outcome?.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(DocxArchiveError);
        } else if (outcome?.status === "fulfilled") {
          expect(Object.keys(outcome.value.files).length).toBeLessThanOrEqual(
            DOCX_MAX_ENTRIES,
          );
          for (const entry of Object.values(outcome.value.files)) {
            if (entry.dir) {
              continue;
            }
            const originalName = entry.unsafeOriginalName ?? entry.name;
            expect(originalName.startsWith("/")).toBe(false);
            expect(originalName.includes("\\")).toBe(false);
            expect(originalName.split("/")).not.toContain("..");
            const content = await extractBinary(outcome.value, entry.name);
            expect(content?.byteLength).toBeLessThanOrEqual(
              DOCX_MAX_ENTRY_BYTES,
            );
          }
        }
        expect(performance.now() - start).toBeLessThan(2000);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);
