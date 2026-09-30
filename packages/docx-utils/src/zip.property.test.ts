import { expect, spyOn, test } from "bun:test";
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

type DirectoryFixtureOptions = {
  names: string[];
  count?: number;
  sizeAdjustment?: number;
  declaredSize?: number;
  zip64?: "valid" | "offset" | "count" | "extension";
};

const directoryFixture = ({
  names,
  count = names.length,
  sizeAdjustment = 0,
  declaredSize = 0,
  zip64,
}: DirectoryFixtureOptions): Uint8Array => {
  const encoded = names.map((name) => new TextEncoder().encode(name));
  const localSize = encoded.reduce((sum, name) => sum + 30 + name.length, 0);
  const directorySize = encoded.reduce(
    (sum, name) => sum + 46 + name.length,
    0,
  );
  const bytes = new Uint8Array(
    localSize + directorySize + (zip64 ? 76 : 0) + 22,
  );
  const view = new DataView(bytes.buffer);
  let local = 0;
  let central = localSize;
  for (const name of encoded) {
    view.setUint32(local, 0x04_03_4b_50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 26, name.length, true);
    bytes.set(name, local + 30);
    view.setUint32(central, 0x02_01_4b_50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint32(central + 24, declaredSize, true);
    view.setUint16(central + 28, name.length, true);
    view.setUint32(central + 42, local, true);
    bytes.set(name, central + 46);
    local += 30 + name.length;
    central += 46 + name.length;
  }
  if (zip64) {
    view.setUint32(central, 0x06_06_4b_50, true);
    view.setBigUint64(central + 4, zip64 === "extension" ? 45n : 44n, true);
    view.setUint16(central + 12, 45, true);
    view.setUint16(central + 14, 45, true);
    view.setBigUint64(central + 24, BigInt(count), true);
    view.setBigUint64(
      central + 32,
      zip64 === "count" ? 0x1_00_00_00_01n : BigInt(count),
      true,
    );
    view.setBigUint64(central + 40, BigInt(directorySize), true);
    view.setBigUint64(central + 48, BigInt(localSize), true);
    view.setUint32(central + 56, 0x07_06_4b_50, true);
    view.setBigUint64(
      central + 64,
      zip64 === "offset" ? 0x1_00_00_00_00n + BigInt(central) : BigInt(central),
      true,
    );
    view.setUint32(central + 72, 1, true);
    central += 76;
  }
  view.setUint32(central, 0x06_05_4b_50, true);
  view.setUint16(central + 8, zip64 ? 65_535 : count, true);
  view.setUint16(central + 10, zip64 ? 65_535 : count, true);
  view.setUint32(
    central + 12,
    zip64 ? 0xff_ff_ff_ff : directorySize + sizeAdjustment,
    true,
  );
  view.setUint32(central + 16, zip64 ? 0xff_ff_ff_ff : localSize, true);
  return bytes;
};

test(
  "archive metadata is checked before loading",
  async () => {
    const loader = spyOn(JSZip, "loadAsync");
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (count) => {
          const names = Array.from(
            { length: count },
            (_, id) => `part-${id}.bin`,
          );
          const fixtures = [
            { names, count: 1 },
            { names: Array.from({ length: count }, () => "part.bin") },
            { names, count: count - 1 },
            { names, sizeAdjustment: -1 },
            { names, sizeAdjustment: 1 },
            { names, zip64: "offset" },
            { names, zip64: "count" },
            { names, zip64: "extension" },
            { names, declaredSize: DOCX_MAX_ENTRY_BYTES + 1 },
          ] as const satisfies readonly DirectoryFixtureOptions[];
          for (const fixture of fixtures) {
            loader.mockClear();
            await expectArchiveError(
              loadDocx(directoryFixture(fixture), {
                maxEntries:
                  "count" in fixture && fixture.count === 1 ? count - 1 : count,
              }),
            );
            expect(loader).not.toHaveBeenCalled();
          }
        }),
        propertyConfig({ seed: propertySeed(), numRuns: 20 }),
      );
    } finally {
      loader.mockRestore();
    }
  },
  propertyTestTimeout(5000),
);

test("archive loading supports fixed ZIP64 metadata", async () => {
  const zip = await loadDocx(
    directoryFixture({ names: ["part.bin"], zip64: "valid" }),
  );
  expect(await extractText(zip, "part.bin")).toBe("");
});

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
    expect(Object.keys(zip.files)).toHaveLength(4000);
    expect(
      new Uint8Array(
        (await extractBinary(zip, "word/part-3999.bin")) ?? new ArrayBuffer(0),
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
      const content = await extractBinary(zip, `word/media/image-${id}.bin`);
      expect(content?.byteLength).toBe(image.length);
      const bytes = new Uint8Array(content ?? new ArrayBuffer(0));
      expect(bytes.at(0)).toBe(73);
      expect(bytes.at(-1)).toBe(73);
    }
  },
  propertyTestTimeout(15_000),
);
