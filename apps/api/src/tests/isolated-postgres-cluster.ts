import { panic } from "better-result";
import {
  chownSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

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
  const socketDir = path.join(root, "sock");
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
      { stdout: "pipe", stderr: "pipe" },
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
    mkdirSync(socketDir);
    if (runNativeAsPostgres) {
      chownSync(
        passwordFile,
        postgresIdentity?.uid ?? 0,
        postgresIdentity?.gid ?? 0,
      );
      chownSync(
        socketDir,
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
          `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${socketDir}`,
          "start",
        ]);
        checked([
          "createdb",
          "-h",
          socketDir,
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
          "-p",
          `127.0.0.1:${port}:5432`,
          "-d",
          "postgres:18.6",
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
    await waitForExternalState({
      description: "the isolated PostgreSQL fixture accepts connections",
      intervalMs: 100,
      timeoutMs: 10_000,
      read: () => command(readiness).exitCode === 0,
    });
    return await run(
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
    );
  } finally {
    try {
      if (started) {
        if (fixture.type === "native") {
          checked(["pg_ctl", "-D", dataDir, "-m", "immediate", "-w", "stop"]);
        } else {
          checked(["docker", "rm", "-fv", fixture.name]);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
};
