import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";

import {
  buildRegistryWriteSummaryRows,
  findCachedReaderAnnotationRows,
  findReaderAnnotationMark,
  getReaderAnnotationEditTargetId,
} from "./tool-approval-summary";

const EMPTY = "(empty)";
const DOCUMENT_LABEL = "(document)";
const UPLOAD_PLACEHOLDER = "(uploaded)";
const build = (toolName: string, input: unknown) =>
  buildRegistryWriteSummaryRows({
    documentLabel: DOCUMENT_LABEL,
    emptyLabel: EMPTY,
    input,
    readerAnnotation: null,
    toolName,
    uploadPlaceholder: UPLOAD_PLACEHOLDER,
  });

describe("buildRegistryWriteSummaryRows", () => {
  test("shows ref params as their chat refs, not raw ids", () => {
    const rows = build("save_matter", {
      matter_id: "mat_1",
      client_id: "contact_2",
      name: "Acme",
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["matter_id"]).toBe("mat_1");
    expect(byKey["client_id"]).toBe("contact_2");
    expect(byKey["name"]).toBe("Acme");
  });

  test("truncates a long value", () => {
    const long = "x".repeat(500);
    const rows = build("save_contact", { notes: long });
    const notes = rows.find((row) => row.key === "notes")?.value ?? "";
    expect(notes.length).toBeLessThan(long.length);
    expect(notes.endsWith("…")).toBe(true);
  });

  test("create_template never dumps the base64 upload", () => {
    const rows = build("create_template", {
      name: "NDA",
      docx_base64: "QUJDR".repeat(1000),
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["name"]).toBe("NDA");
    // The base64 blob is replaced by the caller-supplied placeholder, never
    // rendered, with a caller-supplied (translated) label.
    expect(byKey["docx_base64"]).toBe(UPLOAD_PLACEHOLDER);
    expect(rows.find((row) => row.key === "docx_base64")?.label).toBe(
      DOCUMENT_LABEL,
    );
  });

  test("configure_template_fields summarizes the field manifest as a count", () => {
    const rows = build("configure_template_fields", {
      template_id: "tmpl-abc",
      fields: [{ path: "a" }, { path: "b" }, { path: "c" }],
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["template_id"]).toBe("tmpl-abc");
    expect(byKey["fields"]).toBe("3");
  });

  test("create_template shows a host file by name, never its download URL", () => {
    const rows = build("create_template", {
      name: "NDA",
      file: {
        download_url: "https://files.example/signed?token=secret",
        file_id: "file_123",
        file_name: "nda.docx",
      },
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["file"]).toBe("nda.docx");
    expect(rows.find((row) => row.key === "file")?.label).toBe(DOCUMENT_LABEL);
    expect(rows.map((row) => row.value).join(" ")).not.toContain(
      "token=secret",
    );
  });

  test("create_template falls back to the placeholder for an unnamed host file", () => {
    const rows = build("create_template", {
      name: "NDA",
      file: {
        download_url: "https://files.example/signed",
        file_id: "file_123",
      },
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["file"]).toBe(UPLOAD_PLACEHOLDER);
  });

  test("retired save_template keeps both document forms redacted", () => {
    const rows = build("save_template", {
      name: "NDA",
      docx_base64: "QUJDR".repeat(1000),
      file: {
        download_url: "https://files.example/signed?token=secret",
        file_id: "file_123",
        file_name: "nda.docx",
      },
      fields: [{ path: "a" }, { path: "b" }, { path: "c" }],
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["name"]).toBe("NDA");
    expect(byKey["docx_base64"]).toBe(UPLOAD_PLACEHOLDER);
    expect(byKey["file"]).toBe("nda.docx");
    expect(byKey["fields"]).toBe("3");
    const values = rows.map((row) => row.value).join(" ");
    expect(values).not.toContain("QUJDR");
    expect(values).not.toContain("token=secret");
  });

  test("save_playbook names the positions a call adds, changes, and removes", () => {
    const rows = build("save_playbook", {
      playbook_id: "playbook-1",
      expected_updated_at: "2026-09-20T10:00:00.000Z",
      positions: [
        { mode: "graded", issue: "Liability cap", standard: { tiers: {} } },
        { mode: "graded", issue: "Governing law", source_id: "position-1" },
      ],
      remove_source_ids: ["position-2", "position-3"],
    });

    expect(rows.map(({ label, value }) => [label, value])).toEqual([
      ["Positions added", "Liability cap"],
      ["Positions changed", "Governing law"],
      ["Positions removed", "2"],
    ]);
  });

  test("save_playbook reads a null as absent, as the server does", () => {
    const rows = build("save_playbook", {
      playbook_id: "playbook-1",
      expected_updated_at: "2026-09-20T10:00:00.000Z",
      name: null,
      description: null,
      scope: null,
      positions: [{ mode: "graded", issue: "Liability cap", source_id: null }],
      remove_source_ids: null,
    });

    expect(rows.map(({ label, value }) => [label, value])).toEqual([
      ["Positions added", "Liability cap"],
    ]);
  });

  test("fill_template summarizes the template handle and per-field values", () => {
    const rows = build("fill_template", {
      templateId: "tmpl-abc",
      values: { "tenant.name": "ACME", signing_date: "2026-06-08" },
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["template"]).toBe("tmpl-abc");
    expect(byKey["value:tenant.name"]).toBe("ACME");
    expect(byKey["value:signing_date"]).toBe("2026-06-08");
  });

  test("renders empty label for null/undefined values", () => {
    const rows = build("save_matter", { billing_reference: null });
    expect(rows.find((row) => row.key === "billing_reference")?.value).toBe(
      EMPTY,
    );
  });
});

const annotationRow = ({
  body = null,
  groupId = null,
  id,
  kind,
  quote,
}: {
  body?: string | null;
  groupId?: string | null;
  id: string;
  kind: "comment" | "highlight";
  quote: string;
}) => ({
  authorId: "user-1",
  blockAnchorId: `block-${id}`,
  body,
  color: kind === "highlight" ? "yellow" : null,
  groupId,
  id,
  kind,
  quote,
});

const READER_ROWS = [
  annotationRow({ id: "hl-1", kind: "highlight", quote: "The seller shall" }),
  annotationRow({
    body: "Check the notice period.",
    groupId: "group-1",
    id: "cm-1",
    kind: "comment",
    quote: "First paragraph.",
  }),
  annotationRow({
    groupId: "group-1",
    id: "cm-2",
    kind: "comment",
    quote: "Second paragraph.",
  }),
];

const seededReaderCache = () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["legal-reader", "document"], { id: "hl-1" });
  queryClient.setQueryData(
    readerAnnotationKeys.forTarget({
      activeOrganizationId: "org-1",
      targetId: "decision-1",
      targetType: "decision",
    }),
    READER_ROWS,
  );
  return queryClient;
};

const cachedReaderLists = (queryClient: QueryClient) =>
  queryClient
    .getQueriesData({ queryKey: readerAnnotationKeys.all })
    .map(([, data]) => data);

const lookUpMark = (annotationId: string) => {
  const rows = findCachedReaderAnnotationRows({
    annotationId,
    cachedLists: cachedReaderLists(seededReaderCache()),
  });
  return rows === undefined
    ? null
    : findReaderAnnotationMark({ annotationId, rows });
};

describe("reader annotation approval lookup", () => {
  test("any row of a multi-paragraph mark resolves the whole mark", () => {
    const expected = {
      body: "Check the notice period.",
      kind: "comment",
      quote: "First paragraph. Second paragraph.",
    } as const;
    expect(lookUpMark("cm-1")).toEqual(expected);
    expect(lookUpMark("cm-2")).toEqual(expected);
  });

  test("an ungrouped highlight resolves to its own row only", () => {
    expect(lookUpMark("hl-1")).toEqual({
      body: null,
      kind: "highlight",
      quote: "The seller shall",
    });
  });

  test("a mark no reader holds resolves to nothing", () => {
    expect(lookUpMark("missing")).toBeNull();
  });

  test("the cached list comes back by reference, keeping snapshots stable", () => {
    const queryClient = seededReaderCache();
    const lookUp = () =>
      findCachedReaderAnnotationRows({
        annotationId: "cm-1",
        cachedLists: cachedReaderLists(queryClient),
      });
    expect(lookUp()).toBe(lookUp());
  });

  test("only update and delete name a mark to look up", () => {
    const input = { annotation_id: "cm-1", confirm: true };
    expect(
      getReaderAnnotationEditTargetId({
        input,
        toolName: "delete_reader_annotation",
      }),
    ).toBe("cm-1");
    expect(
      getReaderAnnotationEditTargetId({ input, toolName: "delete_clause" }),
    ).toBeNull();
  });
});

describe("reader annotation approval rows", () => {
  const LABELS = {
    commentText: "Comment text",
    passage: {
      comment: "Commented passage",
      highlight: "Highlighted passage",
    },
  };
  const DELETE_INPUT = { annotation_id: "cm-1", confirm: true };

  test("a found mark replaces its id with what it covers", () => {
    const mark = lookUpMark("cm-1");
    const rows = buildRegistryWriteSummaryRows({
      documentLabel: DOCUMENT_LABEL,
      emptyLabel: EMPTY,
      input: DELETE_INPUT,
      readerAnnotation: mark === null ? null : { labels: LABELS, mark },
      toolName: "delete_reader_annotation",
      uploadPlaceholder: UPLOAD_PLACEHOLDER,
    });
    expect(rows.map(({ key, label, value }) => [key, label, value])).toEqual([
      ["quote", "Commented passage", "First paragraph. Second paragraph."],
      ["body", "Comment text", "Check the notice period."],
      ["confirm", "Confirm", "true"],
    ]);
  });

  test("a highlight's passage row names it and carries no comment text", () => {
    const mark = lookUpMark("hl-1");
    const rows = buildRegistryWriteSummaryRows({
      documentLabel: DOCUMENT_LABEL,
      emptyLabel: EMPTY,
      input: { annotation_id: "hl-1", change: { type: "color", color: "red" } },
      readerAnnotation: mark === null ? null : { labels: LABELS, mark },
      toolName: "update_reader_annotation",
      uploadPlaceholder: UPLOAD_PLACEHOLDER,
    });
    expect(rows.map(({ key, label }) => [key, label])).toEqual([
      ["quote", "Highlighted passage"],
      ["change", "Change"],
    ]);
  });

  test("a mark outside the cache keeps the generic summary", () => {
    const rows = build("delete_reader_annotation", DELETE_INPUT);
    expect(rows.map((row) => row.key)).toEqual(["annotation_id", "confirm"]);
  });
});
