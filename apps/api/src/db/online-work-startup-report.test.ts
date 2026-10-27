import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ONLINE_WORK_NAMES } from "./online-migrations";
import {
  FINALIZED,
  ONLINE_WORK_LIFECYCLE,
  PENDING,
} from "./online-work-lifecycle";
import {
  onlineWorkStartupMetric,
  readOnlineWorkStartupReport,
} from "./online-work-startup-report";
import { ONLINE_WORK_STATES } from "./schema/online-work-state";

describe("online work startup report", () => {
  test("lists every registered unit even before runner checkpoints exist", async () => {
    const statements: string[] = [];
    const report = await readOnlineWorkStartupReport(
      {
        query: async (query) => {
          statements.push(query);
          return [];
        },
      },
      { names: ONLINE_WORK_NAMES, lifecycle: ONLINE_WORK_LIFECYCLE },
    );

    expect(report.units.map(({ name }) => name)).toEqual(ONLINE_WORK_NAMES);
    expect(report.units).toEqual(
      ONLINE_WORK_NAMES.map((name) => ({
        name,
        lifecycle: ONLINE_WORK_LIFECYCLE[name].state,
        state:
          ONLINE_WORK_LIFECYCLE[name].state === "finalized"
            ? "done"
            : "pending",
      })),
    );
    expect(report.pending).toBe(
      report.units.filter(({ lifecycle }) => lifecycle === "pending").length,
    );
    expect(statements).toHaveLength(1);
    expect(statements.at(0)).not.toMatch(/advisory|FOR UPDATE|INSERT|UPDATE/iu);
  });

  test.each(ONLINE_WORK_STATES)(
    "reports durable %s state independently of lifecycle age",
    async (state) => {
      const name = ONLINE_WORK_NAMES.at(0);
      if (name === undefined) {
        throw new TypeError("Expected a registered unit");
      }
      for (const lifecycle of [PENDING, FINALIZED]) {
        const report = await readOnlineWorkStartupReport(
          {
            query: async () => [{ name, state }],
          },
          { names: [name], lifecycle: { [name]: lifecycle } },
        );
        expect(report).toEqual({
          units: [{ name, lifecycle: lifecycle.state, state }],
          pending: state === "done" ? 0 : 1,
        });
      }
    },
  );

  test("rejects corrupt checkpoint states instead of reporting a default", async () => {
    expect(
      String(
        await rejectionOf(
          readOnlineWorkStartupReport(
            {
              query: async () => [
                { name: ONLINE_WORK_NAMES.at(0), state: "unrecognized" },
              ],
            },
            { names: ONLINE_WORK_NAMES, lifecycle: ONLINE_WORK_LIFECYCLE },
          ),
        ),
      ),
    ).toContain("Unknown online work state unrecognized");
  });

  test("keeps checkpoint read failures visible", async () => {
    const failure = new TypeError("Checkpoint connection failed");
    expect(
      await rejectionOf(
        readOnlineWorkStartupReport(
          {
            query: async () => {
              throw failure;
            },
          },
          { names: ONLINE_WORK_NAMES, lifecycle: ONLINE_WORK_LIFECYCLE },
        ),
      ),
    ).toBe(failure);
  });

  test("emits a root pending gauge with no per-unit metric cardinality", () => {
    const metric = onlineWorkStartupMetric({ units: [], pending: 3 }, 42);
    expect(metric).toEqual({
      _aws: {
        Timestamp: 42,
        CloudWatchMetrics: [
          {
            Namespace: "Stella/Api",
            Dimensions: [[]],
            Metrics: [{ Name: "OnlineMigrationsPending", Unit: "Count" }],
          },
        ],
      },
      event: "startup.online_migrations_pending",
      OnlineMigrationsPending: 3,
    });
  });
});
