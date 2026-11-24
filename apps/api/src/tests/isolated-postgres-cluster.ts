import { panic } from "better-result";
import {
  chownSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

/**
 * The image a container fixture starts when the environment names none: the
 * version CI's service containers run, pinned so a run never resolves a tag.
 * CI passes the service image the job has already pulled.
 */
const DEFAULT_CONTAINER_IMAGE =
  "postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42";

/**
 * A throwaway cluster never needs its writes to survive a crash: no flush, so
 * starting it and its DDL wait on no synchronous disk I/O on a busy runner.
 */
const NO_DURABILITY = [
  "-c",
  "fsync=off",
  "-c",
  "full_page_writes=off",
  "-c",
  "synchronous_commit=off",
] as const;

/**
 * Budget for a started server to accept connections. Startup waits on no disk
 * flush and a container that exits ends the wait at once with its log, so
 * only a hung server spends it; it stays under the 30 s budget of the tests
 * that start a cluster.
 */
const READY_TIMEOUT_MS = 25_000;

type IsolatedPostgresOptions = {
  prefix: string;
  database: string;
  user: string;
  password: string;
};

export const withIsolatedPostgresCluster = async <T>(
  { prefix, database, user, password }: IsolatedPostgresOptions,
  run: (databaseUrl: string) => Promise<T>,
): Promise<T> => {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  const dataDir = path.join(root, "data");
  const native = Bun.which("initdb");
  const fixture =
    native === null
      ? ({
          type: "container",
          name: `${prefix}-${Bun.randomUUIDv7()}`,
        } as const)
      : ({ type: "native", initdb: native } as const);
  const runNativeAsPostgres =
    fixture.type === "native" && process.getuid?.() === 0;
  const postgresIdentity = runNativeAsPostgres
    ? {
        uid: Number(
          new TextDecoder().decode(
            Bun.spawnSync(["id", "-u", "postgres"], { stdout: "pipe" }).stdout,
          ),
        ),
        gid: Number(
          new TextDecoder().decode(
            Bun.spawnSync(["id", "-g", "postgres"], { stdout: "pipe" }).stdout,
          ),
        ),
      }
    : null;
  if (runNativeAsPostgres) {
    chownSync(root, postgresIdentity?.uid ?? 0, postgresIdentity?.gid ?? 0);
  }
  const command = (cmd: string[]) =>
    Bun.spawnSync(
      runNativeAsPostgres ? ["runuser", "-u", "postgres", "--", ...cmd] : cmd,
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },
      },
    );
  const checked = (cmd: string[]) => {
    const result = command(cmd);
    if (result.exitCode !== 0) {
      panic(
        `PostgreSQL fixture command failed: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
  };
  let started = false;
  try {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    const port = String(listener.port);
    listener.stop(true);
    const passwordFile = path.join(root, "password");
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    if (runNativeAsPostgres) {
      chownSync(
        passwordFile,
        postgresIdentity?.uid ?? 0,
        postgresIdentity?.gid ?? 0,
      );
    }
    switch (fixture.type) {
      case "native":
        checked([
          fixture.initdb,
          "-D",
          dataDir,
          "-U",
          user,
          "--auth-local=trust",
          "--auth-host=scram-sha-256",
          `--pwfile=${passwordFile}`,
          "-E",
          "utf-8",
          "--locale=C.UTF-8",
          "--no-sync",
        ]);
        started = true;
        checked([
          "pg_ctl",
          "-D",
          dataDir,
          "-w",
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          [
            `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=''`,
            ...NO_DURABILITY,
          ].join(" "),
          "start",
        ]);
        checked([
          "createdb",
          "-h",
          "127.0.0.1",
          "-p",
          port,
          "-U",
          user,
          database,
        ]);
        break;
      case "container":
        started = true;
        checked([
          "docker",
          "run",
          "--name",
          fixture.name,
          "-e",
          `POSTGRES_USER=${user}`,
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          `POSTGRES_DB=${database}`,
          "-e",
          "POSTGRES_INITDB_ARGS=--no-sync",
          // The data directory lives in memory: nothing outlives the fixture.
          "--tmpfs",
          "/var/lib/postgresql",
          "-p",
          `127.0.0.1:${port}:5432`,
          "-d",
          process.env["STELLA_ISOLATED_POSTGRES_IMAGE"] ??
            DEFAULT_CONTAINER_IMAGE,
          ...NO_DURABILITY,
        ]);
        break;
      default:
        fixture satisfies never;
    }
    const readiness =
      fixture.type === "native"
        ? [
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            port,
            "-U",
            user,
            "-d",
            database,
          ]
        : [
            "docker",
            "exec",
            fixture.name,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            user,
            "-d",
            database,
          ];
    const containerStopped = (name: string) =>
      new TextDecoder()
        .decode(
          command(["docker", "inspect", "--format", "{{.State.Running}}", name])
            .stdout,
        )
        .trim() === "false";
    await waitForExternalState({
      description: "the isolated PostgreSQL fixture accepts connections",
      intervalMs: 100,
      timeoutMs: READY_TIMEOUT_MS,
      read: () => {
        if (command(readiness).exitCode === 0) {
          return true;
        }
        // A container whose entrypoint failed never becomes ready: report it
        // now, with what the server said.
        if (fixture.type === "container" && containerStopped(fixture.name)) {
          const log = command(["docker", "logs", "--tail", "50", fixture.name]);
          return panic(
            `The isolated PostgreSQL container stopped before it accepted connections:\n${new TextDecoder().decode(log.stdout)}${new TextDecoder().decode(log.stderr)}`,
          );
        }
        return false;
      },
    });
    return await run(
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
    );
  } finally {
    try {
      if (started) {
        if (fixture.type === "native") {
          // Startup can fail before a PID exists; keep the original failure.
          if (existsSync(path.join(dataDir, "postmaster.pid"))) {
            checked(["pg_ctl", "-D", dataDir, "-m", "immediate", "-w", "stop"]);
          }
        } else {
          checked(["docker", "rm", "-fv", fixture.name]);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
};
