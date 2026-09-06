import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { FieldMeta } from "@/api/lib/docx/types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

import {
  describeStoredTemplate,
  fillStoredTemplateDocx,
  fillTemplateDocx,
} from "./template-fill-service";

// ── DOCX fixture helpers (mirrors patch-template.test.ts / templates.test.ts:
// no shared fixture module exists yet, so every suite builds its own) ──────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
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
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const extractTexts = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const documentXmlFile =
    zip.file("word/document.xml") ??
    panic("fixture DOCX is missing word/document.xml");
  const xml = await documentXmlFile.async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/gu)].map(
    (match) => match[1] ?? "",
  );
};

const organizationId = toSafeId<"organization">("org_1");

/** ScopedDb stub covering only what a manifest-carrying fill touches when no
 *  templateId is supplied (clause-slot resolution is skipped): the org
 *  registry-gate read, which `buildResolveRegistryDisabledReason` always issues
 *  once a manifest is present, even with no lookup field in play. */
const stubScopedDb = (): ScopedDb => {
  const fakeTx = {
    query: {
      organizationSettings: { findFirst: async () => undefined },
    },
  };
  // SAFETY: test stub; the required-fields path under test never reaches
  // clause-slot or template-row queries (no templateId is passed).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx)) as unknown as ScopedDb;
};

const requiredTextField: FieldMeta = {
  path: "governing_law",
  label: "Governing law",
  inputType: "text",
  required: true,
};

const makeManifestDocx = async (fields: FieldMeta[]): Promise<Buffer> => {
  const docx = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
  return await writeManifest(docx, { version: 1, fields });
};

describe("fillTemplateDocx required-field rejection", () => {
  test("rejects a fill omitting a required, non-AI-fillable field", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect(result).toEqual({
      requiredFieldsRejection: [
        {
          path: "governing_law",
          label: "Governing law",
          inputType: "text",
          options: null,
        },
      ],
    });
  });

  test("rejects when the required field is present but empty", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "" },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when the required field is whitespace-only", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "   " },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when a required loop item field is missing in one array row", async () => {
    const buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    const withManifest = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", buffer: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "" }] },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect(result).toEqual({
      requiredFieldsRejection: [
        {
          path: "persons.member",
          label: "Member",
          inputType: "text",
          options: null,
        },
      ],
    });
  });

  test("fills when every array row supplies the required loop item field", async () => {
    const buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    const withManifest = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", buffer: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "Bob" }] },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Alice");
    expect(texts.join("")).toContain("Bob");
  });

  test("fills when the required field is provided", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "Czech" },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Governed by Czech law.");
  });

  test("does not reject a required field that is AI-fillable when omitted; drafts it instead", async () => {
    const buffer = await makeManifestDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        aiPrompt: "The governing law most likely intended by the parties.",
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
      aiCollaborators: async () => ({
        generateAiValue: async () => ({ type: "drafted", value: "Slovak" }),
      }),
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Governed by Slovak law.");
    expect(result.aiFieldErrors).toEqual([]);
  });

  test("reports a field the model could not draft and leaves it unfilled", async () => {
    const buffer = await makeManifestDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        aiPrompt: "The governing law most likely intended by the parties.",
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
      aiCollaborators: async () => ({
        generateAiValue: async () => ({
          type: "failed",
          reason: "truncated",
          message: "The model reached its output limit before finishing.",
        }),
      }),
    });

    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    // The cut draft is reported instead of being written into the instrument.
    expect(result.aiFieldErrors).toEqual([
      {
        fieldPath: "governing_law",
        valuePath: "governing_law",
        itemIndex: null,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ]);
    expect(result.unmatchedPlaceholders).toContain("governing_law");
  });

  test("does not reject a required, source-bound field left unfilled", async () => {
    const buffer = await makeManifestDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        source: { kind: "matter", field: "reference" },
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    // No matter is bound (no workspaceId), so the source field simply stays
    // unfilled rather than being flagged as a caller-correctable omission.
    expect("requiredFieldsRejection" in result).toBe(false);
  });

  // The collaborator factory costs an org AI config read and a metered trace,
  // so the service must not resolve it for a manifest that declares no AI
  // field. A factory that throws proves it was never called.
  test("never resolves the AI collaborators for a deterministic manifest", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "Czech" },
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
      aiCollaborators: () =>
        panic("deterministic fill resolved the AI collaborators"),
    });

    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Governed by Czech law.");
  });

  test("does not check required fields on a manifest-less template", async () => {
    const buffer = await makeDocx(WRAP(P("Hello {{name}}.")));

    const result = await fillTemplateDocx({
      source: { name: "Plain", fileName: "plain.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
  });
});

// The service owns the use counter, but a persistence caller that writes its
// own atomic transaction (fill-by-id, save_filled_template) takes it over with
// `useRecording: "caller"`. `fillStoredTemplateDocx` dropped that option while
// forwarding, so those callers bumped the counter twice per fill; these run
// through that wrapper, the one that was broken.

describe("fillStoredTemplateDocx use recording", () => {
  const usedTemplateId = toSafeId<"template">("tmpl_use");
  const storedS3Key = "fake-key-use-recording";
  const storedRow = {
    name: "NDA",
    fileName: "nda.docx",
    s3Key: storedS3Key,
    languages: [],
  };

  /** ScopedDb stub serving the stored template row and counting the
   *  `templates` use-counter update. `findFirst` honours the organization
   *  predicate the loader sends, so a mismatch reads as "not found" exactly as
   *  the query would in Postgres. */
  const storedTemplateScopedDb = (): {
    scopedDb: ScopedDb;
    updates: () => number;
  } => {
    let updates = 0;
    const fakeTx = {
      query: {
        templates: {
          findFirst: async ({
            where,
          }: {
            where: {
              id: { eq: string };
              organizationId?: { eq: string } | undefined;
            };
          }) =>
            // An absent predicate returns the row: that is what the query
            // looked like before, so the cross-organization case below fails
            // if the predicate is ever dropped again.
            where.id.eq === usedTemplateId &&
            (where.organizationId === undefined ||
              where.organizationId.eq === organizationId)
              ? storedRow
              : undefined,
        },
        organizationSettings: { findFirst: async () => undefined },
      },
      update: () => {
        updates += 1;
        return { set: () => ({ where: async () => undefined }) };
      },
    };
    // SAFETY: test stub; this fill touches only the template row, the
    // registry-gate read, and the use-counter update counted above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const scopedDb = (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx)) as unknown as ScopedDb;
    return { scopedDb, updates: () => updates };
  };

  const fillStored = async (
    options: Pick<
      Parameters<typeof fillStoredTemplateDocx>[0],
      "organizationId" | "useRecording"
    >,
  ) => {
    const buffer = await makeManifestDocx([requiredTextField]);
    const { scopedDb, updates } = storedTemplateScopedDb();
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", storedS3Key, buffer);
      const result = await fillStoredTemplateDocx({
        templateId: usedTemplateId,
        values: { governing_law: "Czech" },
        scopedDb,
        requiredFields: "enforce",
        ...options,
      });
      return { result, updates: updates() };
    } finally {
      fakeS3.stop();
    }
  };

  test("bumps the use counter once by default", async () => {
    const { result, updates } = await fillStored({ organizationId });

    expect("buffer" in result).toBe(true);
    expect(updates).toBe(1);
  });

  test("leaves the counter to the caller under useRecording: caller", async () => {
    const { result, updates } = await fillStored({
      organizationId,
      useRecording: "caller",
    });

    expect("buffer" in result).toBe(true);
    expect(updates).toBe(0);
  });

  // Tenant isolation on a cross-tenant-addressable id must not rest on RLS
  // alone: the loader's own predicate has to reject a template that belongs to
  // another organization even when the session role does not.
  test("does not load a template belonging to another organization", async () => {
    const { result, updates } = await fillStored({
      organizationId: toSafeId<"organization">("org_other"),
    });

    expect(result).toEqual({ error: "Template not found." });
    expect(updates).toBe(0);
  });
});

describe("describeStoredTemplate array shape", () => {
  const templateId = toSafeId<"template">("tmpl_1");

  const s3Key = "fake-key-unused-because-loadTemplate-is-bypassed";

  const stubDescribeScopedDb = (): ScopedDb => {
    const fakeTx = {
      query: {
        templates: {
          findFirst: async () => ({
            name: "Engagement letter",
            fileName: "engagement.docx",
            s3Key,
          }),
        },
      },
    };
    // SAFETY: test stub; describeStoredTemplate only reads the templates row
    // through this scopedDb (S3 is exercised separately below via fake-s3).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx)) as unknown as ScopedDb;
  };

  test("groups an {{#each}} loop over object items under `arrays`, distinct from `fields`", async () => {
    let buffer = await makeDocx(
      WRAP(
        [
          P("{{#each deliverables}}"),
          P("{{deliverables.name}} due {{deliverables.due_date}}"),
          P("{{/each}}"),
        ].join(""),
      ),
    );
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [
        { path: "deliverables.name", label: "Name", inputType: "text" },
        {
          path: "deliverables.due_date",
          label: "Due date",
          inputType: "date",
        },
      ],
    });

    // describeStoredTemplate loads via S3; exercise it against the fake store.
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
      const result = await describeStoredTemplate({
        templateId,
        organizationId,
        scopedDb: stubDescribeScopedDb(),
      });

      if ("error" in result) {
        throw new Error(`unexpected error: ${result.error}`);
      }
      expect(result.arrays).toHaveLength(1);
      const group = result.arrays.at(0);
      expect(group?.path).toBe("deliverables");
      expect(group?.itemFieldPaths.toSorted()).toEqual(["due_date", "name"]);
      // The item fields still appear individually in `fields` too.
      expect(result.fields.map((field) => field.path).toSorted()).toEqual([
        "deliverables.due_date",
        "deliverables.name",
      ]);
    } finally {
      fakeS3.stop();
    }
  });

  test("includes an object-item loop whose sole item field happens to be named `value`", async () => {
    // {{entries.value}} is genuinely ambiguous from marker text alone: it is
    // both the primitive-loop convention (values.entries an array of
    // scalars) and what an object-item loop over `{ value }` rows discovers
    // (values.entries an array of objects). Suppressing this group entirely
    // would hide the latter, real case from a caller; it must stay listed.
    let buffer = await makeDocx(
      WRAP(
        [P("{{#each entries}}"), P("{{entries.value}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "entries.value", label: "Value", inputType: "text" }],
    });

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
      const result = await describeStoredTemplate({
        templateId,
        organizationId,
        scopedDb: stubDescribeScopedDb(),
      });

      if ("error" in result) {
        throw new Error(`unexpected error: ${result.error}`);
      }
      expect(result.arrays).toEqual([
        { path: "entries", itemFieldPaths: ["value"] },
      ]);
    } finally {
      fakeS3.stop();
    }
  });
});
