import { describe, expect, test } from "bun:test";

import { reserveReferencesPath } from "@/routes/knowledge/-components/skill-resource-path.logic";

describe("reserveReferencesPath", () => {
  test("places a new file under references/", () => {
    const result = reserveReferencesPath("notes.md", false, new Set());
    expect(result).toEqual({ type: "ok", path: "references/notes.md" });
  });

  test("suffixes against paths already present", () => {
    const taken = new Set(["references/notes.md"]);
    const result = reserveReferencesPath("notes.md", false, taken);
    expect(result).toEqual({ type: "ok", path: "references/notes-2.md" });
  });

  test("two identical names in one drop resolve to distinct paths", () => {
    const taken = new Set<string>();
    const first = reserveReferencesPath("report.md", false, taken);
    const second = reserveReferencesPath("report.md", false, taken);
    const third = reserveReferencesPath("report.md", false, taken);
    expect(first).toEqual({ type: "ok", path: "references/report.md" });
    expect(second).toEqual({ type: "ok", path: "references/report-2.md" });
    expect(third).toEqual({ type: "ok", path: "references/report-3.md" });
  });

  test("reserves each assigned path into the shared set", () => {
    const taken = new Set<string>();
    reserveReferencesPath("a.md", false, taken);
    reserveReferencesPath("a.md", false, taken);
    expect(taken).toEqual(new Set(["references/a.md", "references/a-2.md"]));
  });

  test("binary uploads store extracted text as .md", () => {
    expect(reserveReferencesPath("Brief.DOCX", true, new Set())).toEqual({
      type: "ok",
      path: "references/brief.md",
    });
    expect(reserveReferencesPath("scan.pdf", true, new Set())).toEqual({
      type: "ok",
      path: "references/scan.md",
    });
  });

  test("collision resolution preserves the extension on the suffix", () => {
    const taken = new Set(["references/data.json"]);
    expect(reserveReferencesPath("data.json", false, taken)).toEqual({
      type: "ok",
      path: "references/data-2.json",
    });
  });

  test("sanitizes disallowed characters", () => {
    expect(
      reserveReferencesPath("My Notes (draft).md", false, new Set()),
    ).toEqual({ type: "ok", path: "references/my-notes--draft-.md" });
  });

  test("rejects a name that cannot start with an allowed character", () => {
    expect(reserveReferencesPath("---", false, new Set())).toEqual({
      type: "invalid",
    });
  });
});
