import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// A process that only reads the public corpus: the base database and storage
// settings, a strict (production) runtime mode, and no tenant content key.
const publicReaderEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://reader:reader-secret@localhost:5432/stella",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stella-public-corpus",
  S3_REGION: "us-east-1",
} as const;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
// The public case-law search handler: its imports reach the corpus policy
// and the tenant page limit.
const PUBLIC_READER_ENTRY = moduleUrl("handlers/case-law/decisions/search.ts");
const PUBLIC_CORPUS_POLICY = moduleUrl("public-corpus-policy.ts");
const API_ENV = moduleUrl("env.ts");

const run = (script: string, env: Record<string, string>) => {
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", script],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString(),
  };
};

const load = (module: string, env: Record<string, string>) =>
  run(`import ${JSON.stringify(module)};`, env);

describe("public corpus environment", () => {
  test("the public case-law search loads in a strict runtime without a content key", () => {
    // The fixture must reach the fault: even with Valkey configured, these
    // settings refuse the API env for its missing content key.
    const api = load(API_ENV, {
      ...publicReaderEnv,
      REDIS_URL: "redis://localhost:6379",
    });
    expect(api.exitCode).not.toBe(0);
    expect(api.stderr).toContain("CONTENT_ENCRYPTION_KEY");

    // On failure the report carries the child's stderr.
    expect(load(PUBLIC_READER_ENTRY, publicReaderEnv)).toMatchObject({
      exitCode: 0,
    });
  });

  test("the corpus policy budgets the configured public pool", () => {
    const totalConcurrency = (env: Record<string, string>) =>
      run(
        `const { getPublicCorpusClassPolicy } = await import(${JSON.stringify(PUBLIC_CORPUS_POLICY)});
console.log(getPublicCorpusClassPolicy().totalConcurrency);`,
        { ...publicReaderEnv, ...env },
      );
    // Without a dedicated pool, a quarter of the root pool is reserved.
    expect(totalConcurrency({ DATABASE_ROOT_POOL_MAX: "8" }).stdout).toBe("2");
    // A dedicated pool admits three requests per connection.
    expect(
      totalConcurrency({
        PUBLIC_LAW_DATABASE_URL:
          "postgres://reader:reader-secret@localhost:5432/public_law",
        PUBLIC_LAW_DATABASE_POOL_MAX: "3",
      }).stdout,
    ).toBe("9");
  });

  test("the policy refuses an invalid public corpus setting at load", () => {
    const refused = load(PUBLIC_CORPUS_POLICY, {
      ...publicReaderEnv,
      PUBLIC_CORPUS_ASSUMED_REPLICAS: "0",
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("PUBLIC_CORPUS_ASSUMED_REPLICAS");
  });
});
