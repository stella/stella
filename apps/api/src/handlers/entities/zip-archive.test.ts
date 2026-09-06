import { describe, expect, test } from "bun:test";

import {
  buildArchivePaths,
  buildErrorManifest,
  groupFileContentsByEntityId,
  uniquePath,
} from "./zip-archive";
import type { ArchiveNode } from "./zip-archive";

describe("uniquePath", () => {
  test("returns the path unchanged when unseen", () => {
    const seen = new Set<string>();
    expect(uniquePath(seen, "Matter/brief.pdf")).toBe("Matter/brief.pdf");
  });

  test("suffixes before the extension on a collision", () => {
    const seen = new Set(["Matter/brief.pdf"]);
    expect(uniquePath(seen, "Matter/brief.pdf")).toBe("Matter/brief (2).pdf");
  });

  test("suffixes at the end when there is no extension", () => {
    const seen = new Set(["Matter/README"]);
    expect(uniquePath(seen, "Matter/README")).toBe("Matter/README (2)");
  });

  test("increments the suffix across repeated collisions", () => {
    const seen = new Set<string>();
    expect(uniquePath(seen, "scan.pdf")).toBe("scan.pdf");
    expect(uniquePath(seen, "scan.pdf")).toBe("scan (2).pdf");
    expect(uniquePath(seen, "scan.pdf")).toBe("scan (3).pdf");
  });

  test("treats a dot in a directory segment as no extension", () => {
    const seen = new Set(["v1.2/notes"]);
    expect(uniquePath(seen, "v1.2/notes")).toBe("v1.2/notes (2)");
  });
});

describe("buildArchivePaths", () => {
  test("roots every path at the folder's own name", () => {
    const paths = buildArchivePaths({
      rootId: "root",
      rootName: "Matter",
      nodes: [{ id: "f1", parentId: "root", kind: "document", name: "a.pdf" }],
    });
    expect(paths.get("root")).toBe("Matter");
    expect(paths.get("f1")).toBe("Matter/a.pdf");
  });

  test("nests descendants by their parent chain", () => {
    const nodes: ArchiveNode[] = [
      { id: "sub", parentId: "root", kind: "folder", name: "Contracts" },
      { id: "deep", parentId: "sub", kind: "folder", name: "2026" },
      { id: "file", parentId: "deep", kind: "document", name: "lease.pdf" },
    ];
    const paths = buildArchivePaths({
      rootId: "root",
      rootName: "Matter",
      nodes,
    });
    expect(paths.get("deep")).toBe("Matter/Contracts/2026");
    expect(paths.get("file")).toBe("Matter/Contracts/2026/lease.pdf");
  });

  test("sanitizes each segment so a name cannot inject a directory", () => {
    const paths = buildArchivePaths({
      rootId: "root",
      rootName: "Mat/ter",
      nodes: [{ id: "x", parentId: "root", kind: "folder", name: "a/b" }],
    });
    expect(paths.get("root")).toBe("Mat_ter");
    expect(paths.get("x")).toBe("Mat_ter/a_b");
  });

  test("suffixes same-named sibling folders deterministically", () => {
    const paths = buildArchivePaths({
      rootId: "root",
      rootName: "Matter",
      nodes: [
        { id: "b", parentId: "root", kind: "folder", name: "Contracts" },
        { id: "a", parentId: "root", kind: "folder", name: "Contracts" },
      ],
    });

    expect(paths.get("a")).toBe("Matter/Contracts");
    expect(paths.get("b")).toBe("Matter/Contracts (2)");
  });

  test("does not let documents reserve sibling folder segments", () => {
    const paths = buildArchivePaths({
      rootId: "root",
      rootName: "Matter",
      nodes: [
        { id: "a", parentId: "root", kind: "document", name: "Contracts" },
        { id: "b", parentId: "root", kind: "folder", name: "Contracts" },
        { id: "c", parentId: "b", kind: "document", name: "brief.pdf" },
      ],
    });

    expect(paths.get("b")).toBe("Matter/Contracts");
    expect(paths.get("c")).toBe("Matter/Contracts/brief.pdf");
  });

  test("falls back to the root on a parentId cycle without hanging", () => {
    const nodes: ArchiveNode[] = [
      { id: "a", parentId: "b", kind: "folder", name: "A" },
      { id: "b", parentId: "a", kind: "folder", name: "B" },
    ];
    const paths = buildArchivePaths({ rootId: "root", rootName: "R", nodes });
    expect(paths.get("a")?.startsWith("R")).toBe(true);
    expect(paths.get("b")?.startsWith("R")).toBe(true);
  });
});

describe("groupFileContentsByEntityId", () => {
  const file = (fileId: string) => ({
    fileId,
    fileName: `${fileId}.pdf`,
    mimeType: "application/pdf",
  });

  test("keeps every file of an entity, in input order", () => {
    const grouped = groupFileContentsByEntityId([
      { entityId: "doc_1", content: file("a") },
      { entityId: "doc_2", content: file("b") },
      { entityId: "doc_1", content: file("c") },
    ]);

    expect(grouped.get("doc_1")?.map((c) => c.fileId)).toEqual(["a", "c"]);
    expect(grouped.get("doc_2")?.map((c) => c.fileId)).toEqual(["b"]);
  });

  test("leaves entities without a file absent", () => {
    expect(groupFileContentsByEntityId([]).size).toBe(0);
    expect(
      groupFileContentsByEntityId([
        { entityId: "doc_1", content: file("a") },
      ]).get("doc_2"),
    ).toBeUndefined();
  });
});

describe("buildErrorManifest", () => {
  test("lists each failed path and the count", () => {
    const manifest = buildErrorManifest(["Matter/x.pdf", "Matter/y.pdf"]);
    expect(manifest).toContain("2 file(s) failed");
    expect(manifest).toContain("  - Matter/x.pdf");
    expect(manifest).toContain("  - Matter/y.pdf");
  });
});
