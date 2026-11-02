import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stageMigrateEntrypoint } from "../src/db/migrate-entrypoint.test-helpers";

const apiRoot = path.resolve(import.meta.dir, "..");
const generatedEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:15432/cloud_test",
  REDIS_URL: "redis://127.0.0.1:16379",
};
const inheritedEnvironment = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:25432/inherited",
  REDIS_URL: "redis://127.0.0.1:26379",
};
const environmentSource = Object.entries(generatedEnvironment)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n");

const withFixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "api-test-env-"));
  try {
    await mkdir(path.join(directory, "src/db"), { recursive: true });
    await mkdir(path.join(directory, "scripts"));
    await copyFile(
      path.join(apiRoot, "scripts/load-test-env.ts"),
      path.join(directory, "scripts/load-test-env.ts"),
    );
    await symlink(
      path.join(apiRoot, "../../node_modules"),
      path.join(directory, "node_modules"),
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const runEntrypoint = async ({
  directory,
  entrypoint,
  expected,
  args = [],
}: {
  directory: string;
  entrypoint: string;
  expected: typeof generatedEnvironment;
  args?: readonly string[];
}) => {
  const assertion = path.join(directory, "assert-env.ts");
  await Bun.write(
    assertion,
    `import { strict as assert } from "node:assert";
process.on("exit", () => {
  for (const [key, value] of Object.entries(${JSON.stringify(expected)})) {
    assert.equal(process.env[key], value);
  }
  assert.equal(process.env.DB_LOAD_GATE_EBS_SIGNAL, undefined);
  assert.equal(process.env.TZ, "Europe/Prague");
  console.log("test environment verified");
});`,
  );
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-autoload-dotenv",
      "--preload",
      assertion,
      entrypoint,
      ...args,
    ],
    cwd: directory,
    env: {
      ...inheritedEnvironment,
      PATH: process.env["PATH"],
      TZ: "Europe/Prague",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, status };
};

for (const runner of ["run-postgres-tests.ts", "run-valkey-tests.ts"]) {
  test(`${runner} picks up test configuration before service checks and preserves unrelated variables`, async () => {
    await withFixture(async (directory) => {
      const entrypoint = path.join(directory, "scripts", runner);
      await copyFile(path.join(apiRoot, "scripts", runner), entrypoint);
      const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(
        await readFile(entrypoint, "utf-8"),
      );
      for (const { path: dependency } of imports) {
        if (!dependency.startsWith(".") || dependency === "./load-test-env") {
          continue;
        }
        const staged = path.join(directory, "scripts", `${dependency}.ts`);
        await mkdir(path.dirname(staged), { recursive: true });
        await symlink(
          path.join(apiRoot, "scripts", `${dependency}.ts`),
          staged,
        );
      }
      await Bun.write(
        path.join(directory, ".env.test"),
        `${environmentSource}\nTZ=UTC\nDB_LOAD_GATE_EBS_SIGNAL=disabled\n`,
      );
      const result = await runEntrypoint({
        directory,
        entrypoint,
        expected: generatedEnvironment,
        args: ["__no_matching_cloud_fixture__"],
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("matched the selection");
      expect(result.stdout).toContain("test environment verified");

      // Removing the entrypoint's load reproduces the original precedence bug.
      const source = await Bun.file(entrypoint).text();
      await Bun.write(
        entrypoint,
        source.replace(/^loadTestEnv\([^\n]+\);$/mu, ""),
      );
      const mutation = await runEntrypoint({
        directory,
        entrypoint,
        expected: generatedEnvironment,
        args: ["__no_matching_cloud_fixture__"],
      });
      expect(mutation.stdout).not.toContain("test environment verified");
      expect(mutation.stderr).toContain("AssertionError");
    });
  });
}

test("migration preserves the deployment environment despite a local test file", async () => {
  await withFixture(async (directory) => {
    const entrypoint = await stageMigrateEntrypoint(directory);
    await Bun.write(path.join(directory, ".env.test"), environmentSource);
    const result = await runEntrypoint({
      directory,
      entrypoint,
      expected: inheritedEnvironment,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EbsConfigurationMissingError");
    expect(result.stdout).toContain("test environment verified");

    const source = await Bun.file(entrypoint).text();
    await Bun.write(
      entrypoint,
      `import { loadTestEnv } from "../../scripts/load-test-env";\n${source.replace(
        "const ebs =",
        'loadTestEnv(new URL("../../.env.test", import.meta.url).pathname);\nconst ebs =',
      )}`,
    );
    const mutation = await runEntrypoint({
      directory,
      entrypoint,
      expected: inheritedEnvironment,
    });
    expect(mutation.stdout).not.toContain("test environment verified");
    expect(mutation.stderr).toContain("AssertionError");
  });
});

test("an absent test file preserves inherited configuration", async () => {
  await withFixture(async (directory) => {
    const entrypoint = path.join(directory, "load.ts");
    await Bun.write(
      entrypoint,
      'import { loadTestEnv } from "./scripts/load-test-env"; loadTestEnv(".env.test");',
    );
    const result = await runEntrypoint({
      directory,
      entrypoint,
      expected: inheritedEnvironment,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test environment verified");
  });
});

for (const malformed of [
  "not an environment file",
  "NODE_ENV=production\nDATABASE_URL=\nREDIS_URL=redis://127.0.0.1",
]) {
  test(`invalid test configuration fails before overriding inherited variables: ${JSON.stringify(malformed)}`, async () => {
    await withFixture(async (directory) => {
      const entrypoint = path.join(directory, "load.ts");
      await Bun.write(
        entrypoint,
        'import { loadTestEnv } from "./scripts/load-test-env"; loadTestEnv(".env.test");',
      );
      await Bun.write(path.join(directory, ".env.test"), malformed);
      const result = await runEntrypoint({
        directory,
        entrypoint,
        expected: inheritedEnvironment,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(".env.test must define NODE_ENV=test");
      expect(result.stdout).toContain("test environment verified");
    });
  });
}
