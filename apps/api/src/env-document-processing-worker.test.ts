import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import nodePath from "node:path";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stella-test",
  S3_REGION: "us-east-1",
  REDIS_URL: "redis://localhost:6379",
} as const;

const workerEnvModuleUrl = new URL(
  "env-document-processing-worker.ts",
  import.meta.url,
).href;
const repoRoot = new URL("../../..", import.meta.url).pathname;
const apiSourceRoot = nodePath.resolve(repoRoot, "apps/api/src");
const workerEntrypoint = nodePath.resolve(
  apiSourceRoot,
  "scripts/document-processing-worker.ts",
);

const resolveApiModule = (
  importPath: string,
  importer: string,
): string | null => {
  let basePath: string;
  if (importPath.startsWith("@/api/")) {
    basePath = nodePath.resolve(
      apiSourceRoot,
      importPath.slice("@/api/".length),
    );
  } else if (importPath.startsWith(".")) {
    basePath = nodePath.resolve(nodePath.dirname(importer), importPath);
  } else {
    return null;
  }

  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    nodePath.resolve(basePath, "index.ts"),
    nodePath.resolve(basePath, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
};

const collectApiModuleGraph = async (
  entrypoint: string,
  visited = new Set<string>(),
): Promise<Set<string>> => {
  if (visited.has(entrypoint)) {
    return visited;
  }
  visited.add(entrypoint);
  const source = await Bun.file(entrypoint).text();
  const loader = entrypoint.endsWith(".tsx") ? "tsx" : "ts";
  const imports = new Bun.Transpiler({ loader }).scan(source).imports;
  const dependencies = imports
    .map(({ path }) => resolveApiModule(path, entrypoint))
    .filter((path): path is string => path !== null);
  await Promise.all(
    dependencies.map(
      async (dependency) => await collectApiModuleGraph(dependency, visited),
    ),
  );
  return visited;
};

const validateWorkerEnv = (env: Record<string, string | undefined> = baseEnv) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import ${JSON.stringify(workerEnvModuleUrl)};`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

describe("document-processing worker environment", () => {
  test("boots without API auth, frontend, email, or Gotenberg settings", () => {
    expect(validateWorkerEnv().exitCode).toBe(0);
  });

  test("accepts Railway private-network Redis in production", () => {
    expect(
      validateWorkerEnv({
        ...baseEnv,
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        REDIS_URL: "redis://default:password@redis.railway.internal:6379",
      }).exitCode,
    ).toBe(0);
  });

  test("does not pull the full API environment into the worker graph", async () => {
    const modules = await collectApiModuleGraph(workerEntrypoint);

    expect(modules).toContain(
      nodePath.resolve(apiSourceRoot, "env-document-processing-worker.ts"),
    );
    expect(modules).not.toContain(nodePath.resolve(apiSourceRoot, "env.ts"));
  });
});
