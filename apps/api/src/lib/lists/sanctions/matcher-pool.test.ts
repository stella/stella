import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type { ParsedList } from "@stll/sanctions";

import { createSanctionsMatcherPool } from "./matcher-pool";
import type { SanctionsMatcherRequest } from "./matcher-protocol";

const list = (name: string): ParsedList => ({
  version: { source: "eu", publishedAt: "2026-09-20", fileId: null },
  entries: [
    {
      source: "eu",
      issuer: SANCTIONS_SOURCES.eu.issuer,
      sourceId: "fixture",
      referenceNumber: null,
      entityType: "organisation",
      names: [{ name, quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.com/list",
    },
  ],
});
const request = (
  name: string,
  editionId = "first",
): SanctionsMatcherRequest => ({
  source: "eu",
  editionId,
  list: list(name),
  query: { name, entityType: "organisation" },
  cutoff: DEFAULT_CUTOFF,
  limit: 10,
});
const actualWorker = () =>
  new Worker(new URL("sanctions-matcher-worker.ts", import.meta.url));

for (const fault of ["hang", "crash"] as const) {
  test(`${fault} returns unavailable, recycles the worker, and the next request answers`, async () => {
    let spawned = 0;
    const pool = createSanctionsMatcherPool({
      deadlineMs: 150,
      createWorker: () => {
        spawned += 1;
        return spawned === 1
          ? new Worker(
              new URL("test-fixtures/matcher-fault-worker.ts", import.meta.url),
              { workerData: fault },
            )
          : actualWorker();
      },
    });
    try {
      const start = performance.now();
      expect(
        await pool.run(
          async (session) => await session.match(request("Acme Trading")),
        ),
      ).toBeNull();
      expect(performance.now() - start).toBeLessThan(500);
      const next = await pool.run(
        async (session) => await session.match(request("Acme Trading")),
      );
      expect(next?.status).toBe("screened");
      expect(spawned).toBe(2);
    } finally {
      await pool.close();
    }
  });
}

test("cached worker results match direct screening and replace changed editions", async () => {
  const pool = createSanctionsMatcherPool({ deadlineMs: 2000 });
  try {
    const first = request("Acme Trading");
    const expected = screen(
      buildScreeningIndex([list("Acme Trading")]),
      first.query,
      {
        cutoff: first.cutoff,
        limit: first.limit,
      },
    ).unwrap();
    expect(
      await pool.run(async (session) => await session.match(first)),
    ).toEqual({ status: "screened", result: expected });
    const changed = request("Different Enterprise", "second");
    changed.query = first.query;
    const newExpected = screen(
      buildScreeningIndex([list("Different Enterprise")]),
      changed.query,
      { cutoff: changed.cutoff, limit: changed.limit },
    ).unwrap();
    expect(
      await pool.run(async (session) => await session.match(changed)),
    ).toEqual({ status: "screened", result: newExpected });
    expect(newExpected.possibleMatches).toHaveLength(0);
    expect(
      await pool.run(async (session) => {
        expect(session.hasEdition("eu", "first")).toBe(false);
        expect(session.hasEdition("eu", "second")).toBe(true);
        return await session.match({ ...changed, list: null });
      }),
    ).toEqual({ status: "screened", result: newExpected });
  } finally {
    await pool.close();
  }
});

test("bundled runtime loads the deployed matcher worker", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } =
    await import("node:fs");
  const { default: path } = await import("node:path");
  const directory = mkdtempSync(path.join(import.meta.dir, ".tmp-matcher-"));
  try {
    const workers = path.join(directory, "workers");
    const parent = path.join(directory, "parent");
    mkdirSync(workers);
    mkdirSync(parent);
    const entrypoint = path.join(directory, "entrypoint.ts");
    writeFileSync(
      entrypoint,
      `import { createSanctionsMatcherPool } from ${JSON.stringify(path.join(import.meta.dir, "matcher-pool.ts"))};
const pool = createSanctionsMatcherPool({ deadlineMs: 2000 });
const response = await pool.run(async (session) => await session.match(${JSON.stringify(request("Acme Trading"))}));
await pool.close();
if (response?.status !== "screened" || response.result.possibleMatches.length !== 1) { process.exit(1); }
`,
    );
    const workerBuild = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "sanctions-matcher-worker.ts")],
      naming: "sanctions-matcher-worker.js",
      outdir: workers,
      target: "bun",
    });
    expect(workerBuild.success).toBe(true);
    const parentBuild = await Bun.build({
      entrypoints: [entrypoint],
      outdir: parent,
      target: "bun",
    });
    expect(parentBuild.success).toBe(true);
    const child = Bun.spawn({
      cmd: ["bun", path.join(parent, "entrypoint.js")],
      env: { ...process.env, STELLA_WORKER_DIR: workers },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cold construction and adversarial warm matching leave timers responsive", async () => {
  const template = list("Acme").entries.at(0);
  if (template === undefined) {
    throw new Error("Missing matcher fixture entry");
  }
  const corpus: ParsedList = {
    version: list("Acme").version,
    entries: Array.from({ length: 20_000 }, (_, index) => ({
      ...template,
      sourceId: `entry-${index}`,
      names: [
        {
          name: `Registered Entity${index} Holdings`,
          quality: "strong" as const,
        },
      ],
    })),
  };
  const pool = createSanctionsMatcherPool({ deadlineMs: 5000 });
  const timed = async (name: string, cold: boolean) => {
    let previous = performance.now();
    const start = previous;
    let maxGapMs = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - previous);
      previous = now;
      ticks += 1;
    }, 1);
    try {
      const response = await pool.run(
        async (session) =>
          await session.match({ ...request(name), list: cold ? corpus : null }),
      );
      const totalMs = performance.now() - start;
      maxGapMs = Math.max(maxGapMs, performance.now() - previous);
      expect(response).not.toBeNull();
      expect(ticks).toBeGreaterThan(0);
      expect(maxGapMs).toBeLessThan(50);
      console.info(
        JSON.stringify({
          workerMatcher: name,
          cold,
          totalMs: Number(totalMs.toFixed(2)),
          maxGapMs: Number(maxGapMs.toFixed(2)),
        }),
      );
      return response;
    } finally {
      clearInterval(timer);
    }
  };
  try {
    expect((await timed("Registered Entity42 Holdings", true))?.status).toBe(
      "screened",
    );
    await timed("Registered Entity42 Holdings", false);
    await timed("Registered Entity Holdings", false);
    await timed(
      "Registered a b c d e f g h i j k l m n o p q r s t u v z",
      false,
    );
  } finally {
    await pool.close();
  }
}, 20_000);

test("deadline replies retain admission until unfinished operations settle", async () => {
  const pool = createSanctionsMatcherPool({ size: 2, deadlineMs: 20 });
  const held = Promise.withResolvers<undefined>();
  let started = 0;
  let unfinished = 0;
  let peak = 0;
  const operation = async () => {
    started += 1;
    unfinished += 1;
    peak = Math.max(peak, unfinished);
    await held.promise;
    unfinished -= 1;
    return "settled";
  };
  try {
    for (const _attempt of Array.from({ length: 8 })) {
      expect(await pool.run(operation)).toBeNull();
    }
    expect(started).toBe(2);
    expect(unfinished).toBe(2);
    expect(peak).toBe(2);
    held.resolve(undefined);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unfinished).toBe(0);
    expect(await pool.run(async () => "recovered", { deadlineMs: 1000 })).toBe(
      "recovered",
    );
  } finally {
    held.resolve(undefined);
    await pool.close();
  }
});
