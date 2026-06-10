import { describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

// ── In-memory S3 ─────────────────────────────────────────
// The diff endpoint loads version snapshots straight from S3;
// the mock serves the buffers this test "saved" per version key.

const s3Objects = new Map<string, Buffer>();

// Spread the real module so other exports stay intact for
// transitive importers; only `getS3` is replaced.
const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  getS3: () => ({
    file: (key: string) => ({
      arrayBuffer: async () => {
        const buf = s3Objects.get(key);
        if (!buf) {
          throw new Error(`Missing S3 object: ${key}`);
        }
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
      },
    }),
  }),
}));

const { loadTemplateVersionDiffSources } = await import("./versions");

// ── DOCX fixtures ────────────────────────────────────────

const makeDocx = async (bodyXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org` +
      `/wordprocessingml/2006/main">` +
      `<w:body>${bodyXml}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** A single-cell table containing one paragraph; legal templates
 *  keep party details and signature blocks in tables. */
const TABLE = (cellText: string) =>
  "<w:tbl>" +
  `<w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>` +
  `<w:tr><w:tc>${P(cellText)}</w:tc></w:tr>` +
  "</w:tbl>";

// ── DB stub ──────────────────────────────────────────────

type StubVersionRow = {
  id: SafeId<"templateVersion">;
  version: number;
  s3Key: string;
};

/** Replays the three queries `loadTemplateVersionDiffSources`
 *  issues: template ownership, the requested version row, and the
 *  highest version below it (the predecessor). */
const makeScopedDb = (versions: StubVersionRow[]): ScopedDb => {
  let requestedVersion: number | null = null;

  const tx = {
    query: {
      templates: {
        findFirst: async () => ({ id: toSafeId<"template">("tpl_1") }),
      },
      templateVersions: {
        findFirst: async (args: { where: { id: { eq: string } } }) => {
          const row = versions.find((v) => v.id === args.where.id.eq);
          if (!row) {
            return undefined;
          }
          requestedVersion = row.version;
          return { version: row.version, s3Key: row.s3Key };
        },
      },
    },
    select: () => tx,
    from: () => tx,
    where: () => tx,
    orderBy: () => tx,
    limit: async (n: number) => {
      const target = requestedVersion;
      if (target === null) {
        throw new Error("previous-version query ran before version lookup");
      }
      return versions
        .filter((v) => v.version < target)
        .toSorted((a, b) => b.version - a.version)
        .slice(0, n)
        .map((v) => ({ s3Key: v.s3Key }));
    },
  };

  // SAFETY: test stub; the fake tx implements exactly the query
  // surface `loadTemplateVersionDiffSources` touches.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (fn: (t: typeof tx) => unknown) =>
    fn(tx)) as unknown as ScopedDb;
};

// ── Tests ────────────────────────────────────────────────

const organizationId = toSafeId<"organization">("org_1");
const templateId = toSafeId<"template">("tpl_1");

describe("template version diff", () => {
  test("two saves differing only inside a table produce a non-empty diff", async () => {
    // Regression: a field marker added inside a w:tbl between two
    // saves must show up in the diff; extraction previously read
    // only direct body children, so every version extracted to the
    // same text and the UI rendered "No changes".
    s3Objects.set(
      "org_1/templates/tpl_1/v1.docx",
      await makeDocx(P("Agreement") + TABLE("KRS no. pending")),
    );
    s3Objects.set(
      "org_1/templates/tpl_1/v2.docx",
      await makeDocx(P("Agreement") + TABLE("KRS no. {{krs_number}}")),
    );

    const v1Id = toSafeId<"templateVersion">("ver_1");
    const v2Id = toSafeId<"templateVersion">("ver_2");
    const scopedDb = makeScopedDb([
      { id: v1Id, version: 1, s3Key: "org_1/templates/tpl_1/v1.docx" },
      { id: v2Id, version: 2, s3Key: "org_1/templates/tpl_1/v2.docx" },
    ]);

    const sources = await loadTemplateVersionDiffSources({
      scopedDb,
      organizationId,
      templateId,
      versionId: v2Id,
    });

    if (sources.type !== "ok") {
      throw new Error("Expected diff sources to resolve");
    }
    expect(sources.prevText).toContain("KRS no. pending");
    expect(sources.currentText).toContain("{{krs_number}}");

    const segments = buildLineDiffSegments(
      sources.prevText,
      sources.currentText,
    );
    expect(segments.length).toBeGreaterThan(0);
    // The edited table line pairs with its predecessor, so the marker
    // arrives as an inserted run inside a merged "changed" segment.
    const insertedText = segments
      .filter((s) => s.kind === "changed")
      .flatMap((s) => s.runs)
      .filter((run) => run.kind === "ins")
      .map((run) => run.text)
      .join("");
    expect(insertedText).toContain("{{krs_number}}");
  });

  test("first version diffs against the empty document", async () => {
    s3Objects.set(
      "org_1/templates/tpl_1/v1.docx",
      await makeDocx(P("Agreement") + TABLE("KRS no. pending")),
    );

    const v1Id = toSafeId<"templateVersion">("ver_1");
    const scopedDb = makeScopedDb([
      { id: v1Id, version: 1, s3Key: "org_1/templates/tpl_1/v1.docx" },
    ]);

    const sources = await loadTemplateVersionDiffSources({
      scopedDb,
      organizationId,
      templateId,
      versionId: v1Id,
    });

    if (sources.type !== "ok") {
      throw new Error("Expected diff sources to resolve");
    }
    expect(sources.prevText).toBe("");
    expect(sources.currentText).toContain("KRS no. pending");
  });
});
