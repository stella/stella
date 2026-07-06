import { describe, expect, test } from "bun:test";

import { buildRegistryWriteSummaryRows } from "./tool-approval-summary";

const EMPTY = "(empty)";
const build = (toolName: string, input: unknown) =>
  buildRegistryWriteSummaryRows({ emptyLabel: EMPTY, input, toolName });

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

  test("save_template never dumps the base64 upload or the field manifest", () => {
    const rows = build("save_template", {
      name: "NDA",
      docx_base64: "QUJDR".repeat(1000),
      fields: [{ path: "a" }, { path: "b" }, { path: "c" }],
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey["name"]).toBe("NDA");
    // The base64 blob is replaced by a short placeholder, never rendered.
    expect(byKey["docx_base64"]).not.toContain("QUJDR");
    // The field manifest is summarized as a count.
    expect(byKey["fields"]).toBe("3");
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
