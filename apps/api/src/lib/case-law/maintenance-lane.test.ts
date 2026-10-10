import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { createEuCompletionStore } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import {
  CASE_LAW_MAINTENANCE_LANE,
  createMaintenanceLaneSession,
  enterCaseLawMaintenanceLane,
  holdCaseLawMaintenanceLane,
} from "@/api/lib/case-law/maintenance-lane";

const API_SRC = path.resolve(import.meta.dir, "../..");
const SCRIPTS_DIR = path.join(API_SRC, "scripts");

/** The two doors; a case-law script imports at least one, and nothing else. */
const LANE_MODULE = "@/api/lib/case-law/maintenance-lane";
const DOORS = [
  "enterCaseLawMaintenanceLane",
  "openCaseLawReadOnlySession",
] as const;

/** The handles a script must not reach for directly: the "third way". */
const DIRECT_HANDLE_IMPORTS = [
  /import\s*\{[^}]*\b(?:rootDb|rlsDb)\b[^}]*\}\s*from\s*"@\/api\/db\/root"/u,
  /import\s*\{[^}]*\b(?:createIngestionDb|createScopedDb)\b[^}]*\}\s*from\s*"@\/api\/db\/scoped"/u,
] as const;

/**
 * Modules whose direct import marks a script as a case-law script. Direct,
 * not transitive: shared libraries reach these from almost anywhere, and a
 * script that writes through a helper imports that helper itself.
 */
const CASE_LAW_MODULE_PREFIXES = [
  "@/api/handlers/case-law/",
  "@/api/lib/case-law/",
  "@/api/lib/legal-search/",
] as const;

/** Direct references that mark a script as a case-law script. */
const CASE_LAW_TABLE_MARKERS = ["case_law_", "caseLaw"] as const;

/**
 * Modules through which a script can reach the database at all. Followed
 * transitively: a script that never imports one, directly or through a
 * helper, issues no statements and needs no door.
 */
const DATABASE_MODULES = [
  "@/api/db/root",
  "@/api/db/scoped",
  "@/api/db/long-running-connection",
] as const;

type EuCompletionStore = ReturnType<typeof createEuCompletionStore>;

/**
 * Scripts that write only their own job's control rows. A stop or approval
 * must not queue behind the job it controls, so these take no door; the
 * census checks they call nothing beyond the declared control methods.
 */
const CONTROL_PLANE_SCRIPTS = {
  "eu-completion-control.ts": {
    reason:
      "Writes only EU completion controls and supervised approvals; a stop must not wait behind the running tick.",
    methods: ["setControl", "approveSupervisedDryRun"],
  },
} as const satisfies Record<
  string,
  { reason: string; methods: readonly (keyof EuCompletionStore)[] }
>;

/** How far the resolver follows imports when looking for database reach. */
const IMPORT_DEPTH_LIMIT = 6;

/**
 * Runtime import edges only: `import type` and `export type` carry no code,
 * so a planner that borrows a type from a storage module reaches no storage.
 */
const IMPORT_SPECIFIER =
  /(?:import|export)\s+(?!type\b)[^;]*?from\s*"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/gu;

const scriptFiles = (): string[] =>
  readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .toSorted();

const readSource = (name: string): string =>
  readFileSync(path.join(SCRIPTS_DIR, name), "utf-8");

const importBase = (fromFile: string, specifier: string): string | null => {
  if (specifier.startsWith("@/api/")) {
    return path.join(API_SRC, specifier.slice("@/api/".length));
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  return null;
};

const resolveImport = (fromFile: string, specifier: string): string | null => {
  const base = importBase(fromFile, specifier);
  if (base === null) {
    return null;
  }
  return (
    [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((file) =>
      existsSync(file),
    ) ?? null
  );
};

const importSpecifiers = (source: string): string[] => {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      found.push(specifier);
    }
  }
  return found;
};

type ImportGraph = {
  /** Every file reachable from the entry, the entry itself included. */
  files: readonly string[];
  specifiers: ReadonlySet<string>;
};

/** Everything reachable from a file through relative and alias imports. */
const importGraph = (entry: string): ImportGraph => {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const walk = (file: string, depth: number): void => {
    if (depth > IMPORT_DEPTH_LIMIT || files.has(file)) {
      return;
    }
    files.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf-8"))) {
      specifiers.add(specifier);
      const resolved = resolveImport(file, specifier);
      if (resolved !== null) {
        walk(resolved, depth + 1);
      }
    }
  };
  walk(entry, 0);
  return { files: [...files], specifiers };
};

const isCaseLawScript = (name: string): boolean => {
  const source = readSource(name);
  return (
    CASE_LAW_TABLE_MARKERS.some((marker) => source.includes(marker)) ||
    importSpecifiers(source).some((specifier) =>
      CASE_LAW_MODULE_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
    )
  );
};

/** Whether a script can issue a statement: it imports a database module or opens a door. */
const reachesDatabase = (name: string): boolean => {
  const { specifiers } = importGraph(path.join(SCRIPTS_DIR, name));
  return (
    specifiers.has(LANE_MODULE) ||
    DATABASE_MODULES.some((module) => specifiers.has(module))
  );
};

/** The doors one file's own source opens. */
const doorsImported = (source: string): string[] =>
  source.includes(`from "${LANE_MODULE}"`)
    ? DOORS.filter((door) => new RegExp(`\\b${door}\\b`, "u").test(source))
    : [];

/**
 * The doors a script opens, in its body or in a helper it runs its pass
 * inside. Followed as far as database reach is followed: a script that asks
 * a shared bootstrap for the lane enters it exactly once, and a body-only
 * census would read that one entry as no entry at all.
 */
const doorsOpened = (name: string): string[] =>
  importGraph(path.join(SCRIPTS_DIR, name)).files.flatMap((file) =>
    doorsImported(readFileSync(file, "utf-8")),
  );

describe("case-law maintenance lane", () => {
  test("an aborted bounded door refuses work before database initialization", async () => {
    const controller = new AbortController();
    controller.abort();
    const rejected1 = await Result.tryPromise({
      try: async () =>
        await enterCaseLawMaintenanceLane({
          mode: "bounded",
          signal: controller.signal,
          statementTimeout: 5000,
          lockTimeout: 5000,
          work: async () => "must not run",
        }),
      catch: (cause) => cause,
    });
    expect(rejected1.isErr()).toBe(true);
    if (rejected1.isErr()) {
      expect(rejected1.error).toBeInstanceOf(Error);
      if (rejected1.error instanceof Error) {
        expect(rejected1.error.message).toContain("abort");
      }
    }
  });

  // The structural rule: a case-law script that can reach the database does
  // so through one of the two doors and nothing else. A script that imports
  // a handle directly has found a third way and fails here; one that opens
  // no door yet reaches the database has found another, which is the same
  // finding from the other side. Pure planners and formatters reach nothing
  // and need nothing.
  test("every case-law script uses a door and never a direct handle", () => {
    const findings: string[] = [];
    let caseLawScripts = 0;
    for (const name of scriptFiles()) {
      if (
        !isCaseLawScript(name) ||
        !reachesDatabase(name) ||
        Object.hasOwn(CONTROL_PLANE_SCRIPTS, name)
      ) {
        continue;
      }
      caseLawScripts += 1;
      const source = readSource(name);
      if (doorsOpened(name).length === 0) {
        findings.push(`${name}: opens no door`);
      }
      if (DIRECT_HANDLE_IMPORTS.some((pattern) => pattern.test(source))) {
        findings.push(`${name}: imports a database handle directly`);
      }
    }
    expect(caseLawScripts).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });

  // A control-plane script stops or approves a job that may hold the lane,
  // so it must never wait for the lane: it opens no door, and its only
  // writes are the control methods it declares.
  test("control-plane scripts open no door and call only their declared control methods", () => {
    const findings: string[] = [];
    for (const [name, { methods }] of Object.entries(CONTROL_PLANE_SCRIPTS)) {
      if (!scriptFiles().includes(name) || !reachesDatabase(name)) {
        findings.push(`${name}: stale control-plane exemption`);
        continue;
      }
      if (doorsOpened(name).length > 0) {
        findings.push(`${name}: a control-plane script opens a door`);
      }
      const called = Array.from(
        readSource(name).matchAll(/\bstore\.(\w+)\(/gu),
        (match) => match[1] ?? "",
      );
      const declared: readonly string[] = methods;
      for (const method of called) {
        if (!declared.includes(method)) {
          findings.push(`${name}: calls undeclared store method ${method}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  // The inverse: a door only belongs in a case-law script, so the census
  // cannot be padded by a tool that took the lane for no reason.
  test("only case-law scripts open a door", () => {
    const strays = scriptFiles().filter(
      (name) =>
        doorsImported(readSource(name)).length > 0 && !isCaseLawScript(name),
    );
    expect(strays).toEqual([]);
  });

  // The resolver must actually follow imports, or the census above is a
  // grep in disguise: a script that writes only through an imported helper
  // is still a case-law script.
  test("the census follows helper imports, not only the script body", () => {
    const source = readSource("case-law-source-total.ts");
    expect(
      CASE_LAW_TABLE_MARKERS.some((marker) => source.includes(marker)),
    ).toBe(false);
    expect(isCaseLawScript("case-law-source-total.ts")).toBe(true);
  });

  // The same for the door, or a script that enters the lane in a shared
  // bootstrap reads as a script that never enters it.
  test("a door opened in a helper counts as the script's door", () => {
    const source = readSource("backfill-cz-us-judges.ts");
    expect(doorsImported(source)).toEqual([]);
    expect(doorsOpened("backfill-cz-us-judges.ts")).toContain(
      "enterCaseLawMaintenanceLane",
    );
  });

  test("the lane key names its domain and lane apart from the graph lock", () => {
    expect(CASE_LAW_MAINTENANCE_LANE).toEqual({
      domain: "case_law",
      lane: "maintenance",
    });
  });

  // Session semantics on a fake lock connection: the lock statement is issued
  // before the hold is returned, release unlocks then closes, and a release
  // the server does not confirm is an invariant failure.
  test("hold locks, release unlocks and closes", async () => {
    const calls: string[] = [];
    const fake = {
      unsafe: async (statement: string, values?: readonly string[]) => {
        calls.push(`${statement} ${JSON.stringify(values)}`);
        return await Promise.resolve([{ released: true }]);
      },
      end: async () => {
        calls.push("end");
        await Promise.resolve();
      },
    };
    const hold = await holdCaseLawMaintenanceLane({ sql: fake, now: () => 0 });
    expect(hold.waitedMs).toBe(0);
    expect(calls).toEqual([
      'SELECT pg_advisory_lock(hashtext($1), hashtext($2)) ["case_law","maintenance"]',
    ]);
    await hold.release();
    expect(calls.at(-2)).toBe(
      'SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released ["case_law","maintenance"]',
    );
    expect(calls.at(-1)).toBe("end");
  });

  test("a release the server does not confirm panics", async () => {
    const fake = {
      unsafe: async (statement: string) =>
        await Promise.resolve(
          statement.includes("unlock") ? [{ released: false }] : [],
        ),
      end: async () => {
        await Promise.resolve();
      },
    };
    const hold = await holdCaseLawMaintenanceLane({ sql: fake, now: () => 0 });
    expect(await rejectionOf(hold.release())).toHaveProperty(
      "message",
      expect.stringContaining("Maintenance lane was not held"),
    );
  });

  test("a failed lane acquisition closes its session", async () => {
    const failure = new TypeError("Lane acquisition failed");
    let closed = 0;
    const result = await rejectionOf(
      holdCaseLawMaintenanceLane({
        sql: {
          unsafe: async () => {
            throw failure;
          },
          end: async () => {
            closed += 1;
          },
        },
      }),
    );
    expect(result).toBe(failure);
    expect(closed).toBe(1);
  });

  test("a failed unlock closes its session", async () => {
    const failure = new TypeError("Lane unlock failed");
    let closed = 0;
    const hold = await holdCaseLawMaintenanceLane({
      sql: {
        unsafe: async (statement) => {
          if (statement.includes("unlock")) {
            throw failure;
          }
          return [];
        },
        end: async () => {
          closed += 1;
        },
      },
    });
    expect(await rejectionOf(hold.release())).toBe(failure);
    expect(closed).toBe(1);
  });
});

test("failed handle initialization releases the held maintenance session", async () => {
  let released = 0;
  const failure = new TypeError("handle initialization failed");
  const result = await rejectionOf(
    createMaintenanceLaneSession({
      hold: async () => ({
        waitedMs: 0,
        release: async () => {
          released += 1;
        },
      }),
      loadHandles: async () => {
        throw failure;
      },
    }),
  );
  expect(result).toBe(failure);
  expect(released).toBe(1);
});
