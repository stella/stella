import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { integer, pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { timestamptz } from "@/api/db/columns";
import {
  defineTransitions,
  permitsTransition,
  transition,
} from "@/api/lib/db/transitions";

const states = ["queued", "running", "completed", "failed"] as const;
const jobs = pgTable("transition_test_jobs", {
  id: text().primaryKey(),
  status: text({ enum: states }).notNull(),
  attempt: integer().notNull(),
  leaseToken: text(),
  claimedAt: timestamptz("claimed_at"),
  description: text(),
});
const graph = {
  queued: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
} as const;
const spec = defineTransitions(jobs, graph, {
  terminal: ["completed", "failed"],
});
const fenced = defineTransitions(jobs, graph, {
  terminal: ["completed", "failed"],
  fence: "attempt",
});
const dialect = new PgDialect();

const assertTransitionRejected = async (
  operation: Promise<unknown>,
  expected: string | Error,
) => {
  const result = await Result.tryPromise({
    try: async () => await operation,
    catch: (error) => error,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    if (typeof expected === "string") {
      expect(result.error).toHaveProperty(
        "message",
        expect.stringContaining(expected),
      );
    } else {
      expect(result.error).toBe(expected);
    }
  }
};

describe("conditional status transitions", () => {
  test("status transition graph pairs", () => {
    assertProperty(
      "status transition graph pairs",
      fc.property(
        fc.constantFrom(...states),
        fc.constantFrom(...states),
        (from, to) => {
          const expected =
            from === to || graph[from].some((target) => target === to);
          expect(permitsTransition(spec, from, to)).toBe(expected);
          if ((from === "completed" || from === "failed") && from !== to) {
            expect(permitsTransition(spec, from, to)).toBe(false);
          }
        },
      ),
    );
    expect(permitsTransition(spec, "unknown", "unknown")).toBe(false);
  });

  test("a zero-row update returns stale and binds every expected source", async () => {
    const captured: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        captured.push(dialect.sqlToQuery(query));
        return [];
      },
    };
    expect(
      await transition(tx, spec, "job", {
        from: ["queued", "running"],
        to: "failed",
        set: { description: "Failure" },
      }),
    ).toEqual({ type: "stale" });
    const query = captured.at(0);
    expect(query?.params).toEqual([
      "failed",
      "Failure",
      "job",
      "queued",
      "running",
    ]);
    expect(query?.sql).toContain('"status" IN');
    expect(query?.sql).toContain("RETURNING");
  });

  test("a declared fence is bound into the same mutation", async () => {
    const tx = {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const built = dialect.sqlToQuery(query);
        expect(built.sql).toContain('"attempt" IS NOT DISTINCT FROM');
        expect(built.params).toEqual(["running", "job", "queued", 3]);
        return [];
      },
    };
    expect(
      await transition(tx, fenced, "job", {
        from: ["queued"],
        to: "running",
        fence: 3,
      }),
    ).toEqual({ type: "stale" });
  });

  test("untyped callers cannot bypass graph, metadata or fence validation", async () => {
    const tx = { execute: async () => [] };
    const reopen = { from: ["completed"], to: "running" } as const;
    const mixed = { from: ["queued", "failed"], to: "running" } as const;
    const empty = { from: [], to: "running" } as const;
    const missingFence = { from: ["queued"], to: "running" } as const;
    const extraFence = { ...missingFence, fence: 3 } as const;
    const overrideStatus = {
      ...missingFence,
      set: { status: "failed", description: "metadata" },
    } as const;
    const overrideFence = {
      ...extraFence,
      set: { attempt: 4, description: "metadata" },
    } as const;
    const unknownColumn = { ...missingFence, set: { unknown: true } } as const;
    const overrideId = {
      ...missingFence,
      set: { id: "other", description: "metadata" },
    } as const;
    await assertTransitionRejected(
      // @ts-expect-error a terminal source cannot reopen
      transition(tx, spec, "job", reopen),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      // @ts-expect-error every source must permit the target
      transition(tx, spec, "job", mixed),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      // @ts-expect-error an empty source list cannot claim a transition
      transition(tx, spec, "job", empty),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      // @ts-expect-error configured fences are required
      transition(tx, fenced, "job", missingFence),
      "requires its declared fence",
    );
    await assertTransitionRejected(
      // @ts-expect-error unfenced tables reject unexpected fences
      transition(tx, spec, "job", extraFence),
      "has no fence",
    );
    await assertTransitionRejected(
      // @ts-expect-error metadata cannot override the owner's status
      transition(tx, spec, "job", overrideStatus),
      "cannot set status",
    );
    await assertTransitionRejected(
      // @ts-expect-error metadata cannot replace the fence
      transition(tx, fenced, "job", overrideFence),
      "cannot set attempt",
    );
    await assertTransitionRejected(
      // @ts-expect-error metadata must be table columns
      transition(tx, spec, "job", unknownColumn),
      "cannot set unknown",
    );
    await assertTransitionRejected(
      // @ts-expect-error metadata cannot replace the primary key
      transition(tx, spec, "job", overrideId),
      "cannot set id",
    );
  });

  test("invalid definitions fail before any write", () => {
    expect(() =>
      defineTransitions(
        jobs,
        { ...graph, completed: ["running"] },
        { terminal: ["completed", "failed"] },
      ),
    ).toThrow("cannot have outgoing transitions");
    const incomplete = { queued: ["running"] } as const;
    const badTarget = { ...graph, queued: ["unknown"] } as const;
    const badTerminal = { terminal: ["unknown"] } as const;
    const badFence = { terminal: [], fence: "missing" } as const;
    expect(() =>
      // @ts-expect-error every persisted state requires a decision
      defineTransitions(jobs, incomplete, { terminal: [] }),
    ).toThrow("must cover");
    expect(() =>
      // @ts-expect-error targets must be in the persisted domain
      defineTransitions(jobs, badTarget, { terminal: [] }),
    ).toThrow("Unknown transition target");
    expect(() =>
      // @ts-expect-error terminal states must be in the persisted domain
      defineTransitions(jobs, graph, badTerminal),
    ).toThrow("Unknown terminal status");
    expect(() =>
      // @ts-expect-error fence names must be present declared columns
      defineTransitions(jobs, graph, badFence),
    ).toThrow("not a table column");
    const openDomain = pgTable("open_status", { id: text(), status: text() });
    expect(() => defineTransitions(openDomain, {}, { terminal: [] })).toThrow(
      "must cover",
    );
  });

  test("database failures propagate instead of returning a stale or successful result", async () => {
    const failure = new TypeError("transition database unavailable");
    const tx = {
      execute: async () => {
        throw failure;
      },
    };
    await assertTransitionRejected(
      transition(tx, spec, "job", { from: ["queued"], to: "running" }),
      failure,
    );
  });
});
