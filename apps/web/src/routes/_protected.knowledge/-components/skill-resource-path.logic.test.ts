import { describe, expect, test } from "bun:test";

import { reserveKnowledgePath } from "@/routes/_protected.knowledge/-components/skill-resource-path.logic";

describe("reserveKnowledgePath", () => {
  test("places a new file under knowledge/", () => {
    const result = reserveKnowledgePath("notes.md", false, new Set());
    expect(result).toEqual({ type: "ok", path: "knowledge/notes.md" });
  });

  test("suffixes against paths already present", () => {
    const taken = new Set(["knowledge/notes.md"]);
    const result = reserveKnowledgePath("notes.md", false, taken);
    expect(result).toEqual({ type: "ok", path: "knowledge/notes-2.md" });
  });

  test("two identical names in one drop resolve to distinct paths", () => {
    const taken = new Set<string>();
    const first = reserveKnowledgePath("report.md", false, taken);
    const second = reserveKnowledgePath("report.md", false, taken);
    const third = reserveKnowledgePath("report.md", false, taken);
    expect(first).toEqual({ type: "ok", path: "knowledge/report.md" });
    expect(second).toEqual({ type: "ok", path: "knowledge/report-2.md" });
    expect(third).toEqual({ type: "ok", path: "knowledge/report-3.md" });
  });

  test("reserves each assigned path into the shared set", () => {
    const taken = new Set<string>();
    reserveKnowledgePath("a.md", false, taken);
    reserveKnowledgePath("a.md", false, taken);
    expect(taken).toEqual(new Set(["knowledge/a.md", "knowledge/a-2.md"]));
  });

  test("binary uploads store extracted text as .md", () => {
    expect(reserveKnowledgePath("Brief.DOCX", true, new Set())).toEqual({
      type: "ok",
      path: "knowledge/brief.md",
    });
    expect(reserveKnowledgePath("scan.pdf", true, new Set())).toEqual({
      type: "ok",
      path: "knowledge/scan.md",
    });
  });

  test("collision resolution preserves the extension on the suffix", () => {
    const taken = new Set(["knowledge/data.json"]);
    expect(reserveKnowledgePath("data.json", false, taken)).toEqual({
      type: "ok",
      path: "knowledge/data-2.json",
    });
  });

  test("sanitizes disallowed characters", () => {
    expect(
      reserveKnowledgePath("My Notes (draft).md", false, new Set()),
    ).toEqual({ type: "ok", path: "knowledge/my-notes--draft-.md" });
  });

  test("rejects a name that cannot start with an allowed character", () => {
    expect(reserveKnowledgePath("---", false, new Set())).toEqual({
      type: "invalid",
    });
  });
});
