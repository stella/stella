import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  assertPostgresWorkerBudget,
  planPostgresWorkers,
  POSTGRES_IDENTIFIER_BYTES,
  type PostgresAdmin,
  PostgresTemplateConnectionError,
  PostgresWorkerBudgetError,
  runPostgresWorkers,
  workerDatabaseName,
} from "./postgres-test-workers";
import { runTestBatches } from "./run-gated-tests";

test.each([undefined, "./src/tests/setup-postgres.ts"])(
  "each process batch loads the optional %s setup after its environment",
  async (preload) => {
    const commands: string[][] = [];
    expect(
      await runTestBatches({
        batches: [["ordinary.test.ts"], ["isolated.test.ts"]],
        bunArguments: [],
        cwd: process.cwd(),
        gate: "STELLA_RUN_POSTGRES_TESTS",
        gateValue: "true",
        preload,
        spawn: ({ cmd, env }) => {
          commands.push(cmd);
          expect(env["STELLA_RUN_POSTGRES_TESTS"]).toBe("true");
          return { exited: Promise.resolve(0), exitCode: 0, signalCode: null };
        },
      }),
    ).toBe(0);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const environmentIndex = command.indexOf("./src/tests/setup-env.ts");
      expect(environmentIndex).toBeGreaterThan(0);
      if (preload === undefined) {
        expect(command).not.toContain("./src/tests/setup-postgres.ts");
        continue;
      }
      expect(command.slice(environmentIndex + 1, environmentIndex + 3)).toEqual(
        ["--preload", preload],
      );
    }
  },
);

test("a failed ordinary batch still produces one report with later isolated suites", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-gated-runner-"),
  );
  const outfile = path.join(directory, "final.xml");
  const batches = [
    ["ordinary.test.ts"],
    ["isolated-one.test.ts"],
    ["isolated-two.test.ts"],
  ] as const;
  const statuses = [7, 0, 9];
  const calls: string[][] = [];

  try {
    const status = await runTestBatches({
      batches,
      bunArguments: ["--reporter=junit", `--reporter-outfile=${outfile}`],
      cwd: directory,
      gate: "POSTGRES_TESTS",
      gateValue: "1",
      spawn: (options) => {
        const command = [...options.cmd];
        calls.push(command);
        const batchIndex = calls.length - 1;
        const outfileArgument = command.find((argument) =>
          argument.startsWith("--reporter-outfile="),
        );
        const batchOutfile = outfileArgument?.split("=").at(1);
        if (batchOutfile === undefined) {
          throw new Error("Expected a rewritten reporter outfile.");
        }
        const batch = batches.at(batchIndex);
        if (batch === undefined) {
          throw new Error("Expected a test batch.");
        }
        const reportWritten = Bun.write(
          batchOutfile,
          `<testsuites tests="1" failures="${batchIndex === 0 ? "1" : "0"}" errors="0" skipped="0" time="1"><testsuite name="${batch[0]}" /></testsuites>`,
        );
        const exitCode = statuses.at(batchIndex) ?? 1;
        return {
          exited: reportWritten.then(() => exitCode),
          exitCode,
          signalCode: null,
        };
      },
    });

    expect(status).toBe(7);
    expect(calls).toHaveLength(3);
    const report = await Bun.file(outfile).text();
    expect(report).toContain(
      '<testsuites tests="3" failures="1" errors="0" skipped="0" time="3">',
    );
    for (const [index, [suite]] of batches.entries()) {
      expect(report).toContain(`name="${suite}"`);
      if (index > 0) {
        expect(report.indexOf(suite)).toBeGreaterThan(
          report.indexOf(batches.at(index - 1)?.at(0) ?? ""),
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a relative report path resolves against the test working directory", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-gated-runner-"),
  );
  try {
    expect(path.resolve(directory)).not.toBe(process.cwd());
    const status = await runTestBatches({
      batches: [["ordinary.test.ts"]],
      bunArguments: [
        "--reporter=junit",
        "--reporter-outfile",
        "reports/final.xml",
      ],
      cwd: directory,
      gate: "POSTGRES_TESTS",
      gateValue: "1",
      spawn: ({ cmd }) => {
        const batchOutfile = cmd.at(cmd.indexOf("--reporter-outfile") + 1);
        if (batchOutfile === undefined) {
          throw new Error("Expected a rewritten reporter outfile.");
        }
        return {
          exited: Bun.write(
            batchOutfile,
            '<testsuites tests="1"><testsuite name="ordinary.test.ts" /></testsuites>',
          ).then(() => 0),
          exitCode: 0,
          signalCode: null,
        };
      },
    });
    expect(status).toBe(0);
    expect(
      await Bun.file(path.join(directory, "reports/final.xml")).text(),
    ).toContain('name="ordinary.test.ts"');
    expect(
      await Bun.file(path.join(process.cwd(), "reports/final.xml")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const workerFiles = [
  "slow.test.ts",
  "medium.test.ts",
  "fast.test.ts",
  "ddl.test.ts",
];
const workerDurations = {
  "slow.test.ts": 9,
  "medium.test.ts": 5,
  "fast.test.ts": 1,
  "ddl.test.ts": 7,
};

test("Postgres workers balance durations and reserve an exclusive database for DDL", () => {
  const plan = planPostgresWorkers({
    files: workerFiles,
    durations: workerDurations,
    exclusivePaths: new Set(["ddl.test.ts"]),
    workers: 2,
  });
  expect(plan.map(({ batches }) => batches)).toEqual([
    [["slow.test.ts"]],
    [["fast.test.ts", "medium.test.ts"], ["ddl.test.ts"]],
  ]);
  expect(
    plan
      .flatMap(({ batches }) => batches)
      .filter((batch) => batch.includes("ddl.test.ts")),
  ).toEqual([["ddl.test.ts"]]);
});

test("Postgres workers refuse a connection budget that cannot fit", () => {
  expect(() =>
    assertPostgresWorkerBudget({
      workers: 4,
      poolMaxPerWorker: 10,
      maxConnections: 49,
      reserve: 10,
    }),
  ).toThrow(PostgresWorkerBudgetError);
});

test("template cloning refuses and names foreign connections", async () => {
  const fixture = adminFixture();
  const query = fixture.admin.query;
  fixture.admin.query = async (sql, parameters) => {
    if (sql.startsWith("SELECT pid")) {
      return [{ pid: 42, application_name: "psql", client_addr: "127.0.0.1" }];
    }
    return query(sql, parameters);
  };
  const error = await rejectionOf(
    runPostgresWorkers({
      files: ["ordinary.test.ts"],
      durations: {},
      exclusivePaths: new Set(),
      workers: 1,
      databaseUrl: "postgres://localhost/template_db",
      admin: fixture.admin,
      runWorker: () => ({
        exited: Promise.resolve(0),
        exitCode: 0,
        signalCode: null,
        kill: () => undefined,
      }),
    }),
  );
  expect(error).toBeInstanceOf(PostgresTemplateConnectionError);
  expect(error instanceof Error ? error.message : "").toContain(
    "pid=42 application_name=psql client_addr=127.0.0.1",
  );
});

type AdminFixture = {
  admin: PostgresAdmin;
  calls: string[];
};

const adminFixture = (): AdminFixture => {
  const calls: string[] = [];
  return {
    calls,
    admin: {
      query: async (sql, parameters = []) => {
        calls.push(`${sql} ${JSON.stringify(parameters)}`);
        if (sql === "SHOW max_connections") {
          return [{ max_connections: "100" }];
        }
        return [];
      },
      close: async () => {
        calls.push("CLOSE");
      },
    },
  };
};

test.each([0, 7])(
  "cluster-wide migrations drain every worker, remain serial and preserve failure %s",
  async (ordinaryFailure) => {
    const fixture = adminFixture();
    const ordinaryReady = Promise.withResolvers<undefined>();
    const firstClusterReady = Promise.withResolvers<undefined>();
    const secondClusterReady = Promise.withResolvers<undefined>();
    const ordinary = new Map<string, (status: number) => void>();
    const firstCluster = Promise.withResolvers<number>();
    const secondCluster = Promise.withResolvers<number>();
    const started: string[] = [];
    const result = runPostgresWorkers({
      files: ["ordinary-one", "ordinary-two", "migration-one", "migration-two"],
      durations: {},
      exclusivePaths: new Set(),
      clusterExclusivePaths: new Set(["migration-one", "migration-two"]),
      workers: 2,
      databaseUrl: "postgres://localhost/template_db",
      admin: fixture.admin,
      registerSignal: () => () => {},
      runWorker: ({ files }) => {
        expect(files).toHaveLength(1);
        const file = files.at(0);
        if (file === undefined) {
          throw new Error("The runner must supply one fixture file");
        }
        started.push(file);
        let exited: Promise<number>;
        if (file.startsWith("ordinary")) {
          const completion = Promise.withResolvers<number>();
          ordinary.set(file, completion.resolve);
          if (ordinary.size === 2) {
            ordinaryReady.resolve(undefined);
          }
          exited = completion.promise;
        } else if (file === "migration-one") {
          firstClusterReady.resolve(undefined);
          exited = firstCluster.promise;
        } else {
          expect(file).toBe("migration-two");
          secondClusterReady.resolve(undefined);
          exited = secondCluster.promise;
        }
        return { exited, exitCode: null, signalCode: null, kill: () => {} };
      },
      log: () => {},
    });

    await ordinaryReady.promise;
    expect(new Set(started)).toEqual(new Set(["ordinary-one", "ordinary-two"]));
    const finishOrdinary = (file: string, status: number) => {
      const complete = ordinary.get(file);
      if (complete === undefined) {
        throw new Error(`The ordinary fixture ${file} must have started`);
      }
      complete(status);
    };
    finishOrdinary("ordinary-one", ordinaryFailure);
    expect(started).toHaveLength(2);
    finishOrdinary("ordinary-two", 0);
    await firstClusterReady.promise;
    expect(started.slice(2)).toEqual(["migration-one"]);
    firstCluster.resolve(9);
    await secondClusterReady.promise;
    expect(started.slice(2)).toEqual(["migration-one", "migration-two"]);
    secondCluster.resolve(0);

    expect(await result).toBe(ordinaryFailure === 0 ? 9 : ordinaryFailure);
    expect(fixture.calls.at(-1)).toBe("CLOSE");
  },
);

const runWorkerFixture = async ({
  exitCode = 0,
  signal,
}: {
  exitCode?: number;
  signal?: (handler: (signal: NodeJS.Signals) => void) => void;
} = {}) => {
  const fixture = adminFixture();
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  const status = await runPostgresWorkers({
    files: ["ordinary.test.ts"],
    durations: { "ordinary.test.ts": 2 },
    exclusivePaths: new Set(),
    workers: 1,
    databaseUrl: "postgres://owner:secret@localhost:5432/template_db",
    admin: fixture.admin,
    registerSignal: (handler) => {
      signalHandler = handler;
      return () => {
        fixture.calls.push("UNREGISTER");
      };
    },
    runWorker: () => {
      const exited = new Promise<number>((resolve) => {
        queueMicrotask(() => {
          signal?.(signalHandler ?? (() => {}));
          resolve(exitCode);
        });
      });
      return {
        exited,
        exitCode,
        signalCode: null,
        kill: (received) => {
          fixture.calls.push(`KILL ${String(received)}`);
        },
      };
    },
    log: () => {},
  });
  return { ...fixture, status };
};

test("template cloning precedes workers and databases drop in cleanup on success", async () => {
  const { calls, status } = await runWorkerFixture();
  expect(status).toBe(0);
  const create = calls.findIndex((call) => call.startsWith("CREATE DATABASE"));
  const terminate = calls.findIndex((call) =>
    call.startsWith(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend' [\"template_db_test_",
    ),
  );
  const drop = calls.findIndex((call) =>
    call.startsWith("DROP DATABASE IF EXISTS"),
  );
  expect(create).toBeGreaterThan(
    calls.findIndex((call) => call.startsWith("SELECT pid")),
  );
  expect(terminate).toBeGreaterThan(create);
  expect(drop).toBeGreaterThan(terminate);
  expect(calls.at(-1)).toBe("CLOSE");
});

test("worker failure still drops its cloned database", async () => {
  const { calls, status } = await runWorkerFixture({ exitCode: 7 });
  expect(status).toBe(7);
  expect(calls.some((call) => call.startsWith("DROP DATABASE IF EXISTS"))).toBe(
    true,
  );
  expect(calls.at(-1)).toBe("CLOSE");
});

test("signal kills workers before cloned database cleanup", async () => {
  const { calls, status } = await runWorkerFixture({
    signal: (handler) => handler("SIGTERM"),
  });
  expect(status).toBe(143);
  const kill = calls.indexOf("KILL SIGTERM");
  const drop = calls.findIndex((call) =>
    call.startsWith("DROP DATABASE IF EXISTS"),
  );
  expect(kill).toBeGreaterThan(-1);
  expect(drop).toBeGreaterThan(kill);
});

test("clone database names fit the identifier limit and stay distinct", () => {
  for (const template of [
    "template_db",
    "t".repeat(63),
    "š".repeat(40),
    `${"x".repeat(50)}_suffix_that_used_to_be_truncated`,
  ]) {
    const names = [1, 2, 10].flatMap((worker) =>
      ["4242_k1", "4242_k2"].map((runId) =>
        workerDatabaseName({ template, runId, worker }),
      ),
    );
    for (const name of names) {
      expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(
        POSTGRES_IDENTIFIER_BYTES,
      );
    }
    expect(new Set(names).size).toBe(names.length);
  }
  expect(
    workerDatabaseName({ template: "template_db", runId: "1_a", worker: 1 }),
  ).toStartWith("template_db_test_w1_");
});
