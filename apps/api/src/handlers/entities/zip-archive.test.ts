import { describe, expect, test } from "bun:test";

import {
  buildArchivePaths,
  buildErrorManifest,
  mapOrderedConcurrent,
  uniquePath,
} from "./zip-archive";
import type { ArchiveNode } from "./zip-archive";

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

describe("mapOrderedConcurrent", () => {
  test("yields results in input order despite out-of-order completion", async () => {
    // Later items resolve sooner, so completion order is reversed.
    const worker = async (n: number) => {
      await delay((8 - n) * 5);
      return n;
    };
    const results: number[] = [];
    for await (const r of mapOrderedConcurrent([1, 2, 3, 4, 5], 5, worker)) {
      results.push(r);
    }
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  test("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const worker = async (n: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return n;
    };
    const results: number[] = [];
    for await (const r of mapOrderedConcurrent(
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      3,
      worker,
    )) {
      results.push(r);
    }
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("handles empty input", async () => {
    const results: number[] = [];
    for await (const r of mapOrderedConcurrent<number, number>(
      [],
      3,
      async (n) => n,
    )) {
      results.push(r);
    }
    expect(results).toEqual([]);
  });

  test("treats a concurrency below 1 as 1", async () => {
    const results: number[] = [];
    for await (const r of mapOrderedConcurrent([1, 2, 3], 0, async (n) => n)) {
      results.push(r);
    }
    expect(results).toEqual([1, 2, 3]);
  });
});

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

describe("buildErrorManifest", () => {
  test("lists each failed path and the count", () => {
    const manifest = buildErrorManifest(["Matter/x.pdf", "Matter/y.pdf"]);
    expect(manifest).toContain("2 file(s) failed");
    expect(manifest).toContain("  - Matter/x.pdf");
    expect(manifest).toContain("  - Matter/y.pdf");
  });
});
