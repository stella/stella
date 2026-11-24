import { describe, expect, test } from "bun:test";

import {
  FULL_PDF_RENDER_BUDGET,
  type PdfRenderBudget,
  pdfRenderBudget,
} from "@/api/lib/files/pdf-render-budget";
import { LIMITS } from "@/api/lib/limits";
import {
  type LimitFileReader,
  readProcessMemoryLimit,
} from "@/api/lib/observability/process-memory-limit";

const MIB = 1024 * 1024;
const MEMBERSHIP = "/proc/self/cgroup";

const files =
  (contents: Readonly<Record<string, string>>): LimitFileReader =>
  (path) =>
    contents[path] ?? null;

/** A container whose limit is set the cgroup v2 way, on the task's group. */
const v2Container = (bytes: number | "max") =>
  readProcessMemoryLimit(
    files({
      [MEMBERSHIP]: "0::/ecs/task/container\n",
      "/sys/fs/cgroup/ecs/task/container/memory.max": `${bytes}\n`,
    }),
  );

/** The same, the cgroup v1 way. */
const v1Container = (bytes: number) =>
  readProcessMemoryLimit(
    files({
      [MEMBERSHIP]: "4:memory:/ecs/task/container\n",
      "/sys/fs/cgroup/memory/ecs/task/container/memory.limit_in_bytes": `${bytes}\n`,
    }),
  );

/**
 * A derivative worker process with its modules loaded measured 143 MB;
 * this adds room for its connections and the source it holds.
 */
const PARENT_RSS = 200 * MIB;

/** What the container keeps beside the worker. */
const SET_ASIDE =
  PARENT_RSS +
  LIMITS.fileDerivativePdfMaxBytes +
  LIMITS.pdfRenderParentGrowthBytes;

const ceilingIn = (limit: ReturnType<typeof readProcessMemoryLimit>) =>
  pdfRenderBudget({ limit, parentRssBytes: PARENT_RSS })?.workerRssMaxBytes;

describe("the render budget a container has room for", () => {
  test("a 512 MiB container gets what is left beside its parent", () => {
    expect(ceilingIn(v2Container(512 * MIB))).toBe(512 * MIB - SET_ASIDE);
    expect(ceilingIn(v1Container(512 * MIB))).toBe(512 * MIB - SET_ASIDE);
    expect(512 * MIB - SET_ASIDE).toBe(198 * MIB);
  });

  test("a 1 GiB container gets the cap", () => {
    expect(ceilingIn(v2Container(1024 * MIB))).toBe(
      LIMITS.pdfRenderWorkerRssMaxBytes,
    );
    expect(ceilingIn(v1Container(1024 * MIB))).toBe(
      LIMITS.pdfRenderWorkerRssMaxBytes,
    );
  });

  test("no limit, or none readable (development on macOS), gets the full budget", () => {
    const unlimited = v2Container("max");
    const unreadable = readProcessMemoryLimit(files({}));
    expect(unlimited).toEqual({ type: "unlimited" });
    expect(unreadable).toEqual({ type: "unreadable" });
    for (const limit of [unlimited, unreadable]) {
      expect(pdfRenderBudget({ limit, parentRssBytes: PARENT_RSS })).toEqual(
        FULL_PDF_RENDER_BUDGET,
      );
    }
  });

  test("a container with less than the smallest ceiling left gets none", () => {
    const smallest = LIMITS.pdfRenderWorkerRssMinBytes + SET_ASIDE;
    expect(ceilingIn(v2Container(smallest))).toBe(
      LIMITS.pdfRenderWorkerRssMinBytes,
    );
    expect(ceilingIn(v2Container(smallest - 1))).toBeUndefined();
    expect(ceilingIn(v2Container(256 * MIB))).toBeUndefined();
  });

  test("a parent that has grown leaves the worker less", () => {
    const limit = v2Container(1024 * MIB);
    const at = (parentRssBytes: number) =>
      pdfRenderBudget({ limit, parentRssBytes })?.workerRssMaxBytes;
    expect(at(600 * MIB)).toBe(
      1024 * MIB - 600 * MIB - (SET_ASIDE - PARENT_RSS),
    );
    expect(at(900 * MIB)).toBeUndefined();
  });

  test("the worker, its parent and what the parent reads back fit the container", () => {
    for (let megabytes = 128; megabytes <= 4096; megabytes += 32) {
      const limit = v2Container(megabytes * MIB);
      const ceiling = ceilingIn(limit);
      if (ceiling !== undefined) {
        expect(ceiling + SET_ASIDE).toBeLessThanOrEqual(megabytes * MIB);
        expect(ceiling).toBeLessThanOrEqual(LIMITS.pdfRenderWorkerRssMaxBytes);
      }
    }
  });

  test("source budgets shrink with the ceiling, never past one unit", () => {
    const keys = Object.keys(FULL_PDF_RENDER_BUDGET).filter(
      (key): key is Exclude<keyof PdfRenderBudget, "workerRssMaxBytes"> =>
        key !== "workerRssMaxBytes",
    );
    let previous: PdfRenderBudget | null = null;
    for (let megabytes = 4096; megabytes >= 128; megabytes -= 8) {
      const budget = pdfRenderBudget({
        limit: v2Container(megabytes * MIB),
        parentRssBytes: PARENT_RSS,
      });
      if (budget === null) {
        continue;
      }
      for (const key of keys) {
        expect(budget[key]).toBeGreaterThanOrEqual(1);
        expect(budget[key]).toBeLessThanOrEqual(FULL_PDF_RENDER_BUDGET[key]);
        if (previous !== null) {
          expect(budget[key]).toBeLessThanOrEqual(previous[key]);
        }
      }
      previous = budget;
    }
    // In a 512 MiB container a render gets an eighth of the cap's room:
    // (198 - 112 - 40) / (512 - 112 - 40) of each source budget.
    expect(
      pdfRenderBudget({
        limit: v2Container(512 * MIB),
        parentRssBytes: PARENT_RSS,
      }),
    ).toMatchObject({
      textPagesMax: 25,
      textPagesPerFontRun: 6,
      imagePagesMax: 6,
    });
  });
});
