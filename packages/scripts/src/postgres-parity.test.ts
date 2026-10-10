import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("Expected a configuration object");
  }
  return value;
};

const missingWorkflowParity = (source: string): string[] => {
  const workflow: unknown = Bun.YAML.parse(source);
  const failures: string[] = [];
  for (const [jobName, value] of Object.entries(
    record(record(workflow)["jobs"]),
  )) {
    const job = record(value);
    if (job["services"] === undefined) {
      continue;
    }
    for (const [serviceName, serviceValue] of Object.entries(
      record(job["services"]),
    )) {
      const service = record(serviceValue);
      const serviceEnv = service["env"];
      if (!isRecord(serviceEnv) || serviceEnv["POSTGRES_DB"] === undefined) {
        continue;
      }
      const steps = job["steps"];
      if (!Array.isArray(steps)) {
        throw new TypeError("Service jobs must have steps");
      }
      const setupIndex = steps.findIndex((step: unknown) => {
        const run = record(step)["run"];
        return (
          typeof run === "string" &&
          run.includes("scripts/configure-test-postgres.sh") &&
          run.includes(`job.services.${serviceName}.id`) &&
          run.includes("stella_owner")
        );
      });
      const firstConsumer = steps.findIndex((step: unknown) => {
        const env = record(step)["env"];
        return isRecord(env) && typeof env["DATABASE_URL"] === "string";
      });
      if (
        setupIndex === -1 ||
        (firstConsumer !== -1 && setupIndex >= firstConsumer)
      ) {
        failures.push(`${jobName}/${serviceName}`);
      }
    }
  }
  return failures;
};

describe("Postgres execution and owner parity", () => {
  test("every workflow database is configured before its first consumer", async () => {
    const files = [
      ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
        cwd: root,
        dot: true,
      }),
    ];
    let definitions = 0;
    for (const file of files) {
      const source = await readFile(path.join(root, file), "utf-8");
      expect(missingWorkflowParity(source)).toEqual([]);
      // Removing the setup must expose every service in the census.
      const removed = source.replaceAll(
        "scripts/configure-test-postgres.sh",
        "scripts/removed-parity.sh",
      );
      const missing = missingWorkflowParity(removed);
      definitions += missing.length;
      if (source.includes("POSTGRES_DB:")) {
        expect(missing.length).toBeGreaterThan(0);
      }
    }
    expect(definitions).toBeGreaterThan(0);
  });

  test("development servers build the shared image without host config binds", async () => {
    let definitions = 0;
    for (const file of new Bun.Glob("docker-compose*.{yml,yaml}").scanSync({
      cwd: root,
    })) {
      const parsed: unknown = Bun.YAML.parse(
        await readFile(path.join(root, file), "utf-8"),
      );
      for (const value of Object.values(record(record(parsed)["services"]))) {
        const service = record(value);
        const env = service["environment"];
        if (!isRecord(env) || env["POSTGRES_DB"] === undefined) {
          continue;
        }
        definitions++;
        expect(service["build"]).toEqual({
          context: ".",
          dockerfile: "docker/postgres/Dockerfile",
        });
        expect(JSON.stringify(service["volumes"])).not.toContain(
          "./docker/postgres/",
        );
      }
    }
    expect(definitions).toBeGreaterThan(0);
    const dockerfile = await readFile(
      path.join(root, "docker/postgres/Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(
      "COPY docker/postgres/prod-parity.conf /etc/postgresql/prod-parity.conf",
    );
    expect(dockerfile).toContain(
      "COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql",
    );
    expect(dockerfile).toContain("config_file=/etc/postgresql/server.conf");
    expect(
      await readFile(path.join(root, "docker/postgres/server.conf"), "utf-8"),
    ).toContain("include = '/etc/postgresql/prod-parity.conf'");
  });

  test("the dev runner checks reused databases before migrations", async () => {
    const source = await readFile(
      path.join(root, "packages/scripts/src/dev-runner.ts"),
      "utf-8",
    );
    const setup = source.indexOf('"scripts/configure-test-postgres.sh"');
    expect(setup).toBeGreaterThan(
      source.indexOf("await ensureDockerServices({"),
    );
    expect(setup).toBeLessThan(
      source.indexOf("for (const step of preparationSteps)"),
    );
  });

  test.each(["t|t", "t|f", "f|t"])(
    "demotes a reused owner (%s) once and preserves the database on replay",
    async (posture) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "postgres-parity-"));
      try {
        const docker = path.join(fixture, "docker");
        await writeFile(path.join(fixture, "posture"), posture);
        await writeFile(
          path.join(fixture, "data"),
          "existing database content",
        );
        await writeFile(
          docker,
          `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"SELECT rolsuper, rolbypassrls"* ]]; then
  cat "$PARITY_FIXTURE/posture"
  exit
fi
[[ "$*" == *psql* ]] || { echo 'Unexpected container mutation' >&2; exit 1; }
payload=$(cat)
if [[ "$payload" == *"ALTER ROLE %I NOSUPERUSER NOBYPASSRLS"* ]]; then
  printf '%s\\n' "$*" >> "$PARITY_FIXTURE/demotions"
  printf 'f|f' > "$PARITY_FIXTURE/posture"
elif [[ "$payload" == *'DO $$ BEGIN'* ]]; then
  [[ "$(cat "$PARITY_FIXTURE/posture")" == 'f|f' ]] || exit 1
fi
`,
        );
        await chmod(docker, 0o700);
        for (let replay = 0; replay < 2; replay++) {
          const child = Bun.spawn(
            [
              "bash",
              path.join(root, "scripts/configure-test-postgres.sh"),
              "fixture-postgres",
              "postgres",
            ],
            {
              env: {
                ...process.env,
                PATH: `${fixture}:${process.env["PATH"] ?? ""}`,
                PARITY_FIXTURE: fixture,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const stderr = await new Response(child.stderr).text();
          expect(await child.exited, stderr).toBe(0);
        }
        expect(await readFile(path.join(fixture, "posture"), "utf-8")).toBe(
          "f|f",
        );
        expect(await readFile(path.join(fixture, "data"), "utf-8")).toBe(
          "existing database content",
        );
        const demotions = (
          await readFile(path.join(fixture, "demotions"), "utf-8")
        )
          .trim()
          .split("\n");
        expect(demotions).toHaveLength(1);
        expect(demotions.at(0)).toContain(
          posture.startsWith("t|") ? "-U postgres" : "-U stella_bootstrap",
        );
        expect(demotions.at(0)).toContain("owner=postgres");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  test("standalone smoke databases use the same configuration before migrations", async () => {
    let definitions = 0;
    for (const file of new Bun.Glob("scripts/**/*.sh").scanSync({
      cwd: root,
    })) {
      const source = await readFile(path.join(root, file), "utf-8");
      if (!/\b\w*postgres\w*_image=.*postgres:/u.test(source)) {
        continue;
      }
      definitions++;
      const setup = source.indexOf(
        'scripts/configure-test-postgres.sh" "$postgres" postgres',
      );
      expect(setup).toBeGreaterThan(0);
      expect(source.indexOf("\nmigrate\n")).toBeGreaterThan(setup);
    }
    expect(definitions).toBeGreaterThan(0);
  });
});
