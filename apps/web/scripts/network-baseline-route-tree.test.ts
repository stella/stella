import { Generator, getConfig } from "@tanstack/router-generator";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateRevisionRouteTree } from "./network-baseline-route-tree";

const fixture = () => {
  const repository = mkdtempSync(
    path.join(os.tmpdir(), "route-revision-test-"),
  );
  const routes = path.join(repository, "apps/web/src/routes");
  mkdirSync(routes, { recursive: true });
  writeFileSync(
    path.join(routes, "__root.tsx"),
    "import { createRootRoute } from '@tanstack/react-router'; export const Route = createRootRoute();\n",
  );
  writeFileSync(
    path.join(routes, "index.tsx"),
    "import { createFileRoute } from '@tanstack/react-router'; export const Route = createFileRoute('/')({});\n",
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Route test",
      "-c",
      "user.email=route@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  return { repository, routes, commit };
};

test("revision routes produce the committed projection without executing modules or local configuration", async () => {
  const { repository, routes, commit } = fixture();
  try {
    const marker = path.join(repository, "executed");
    writeFileSync(
      path.join(routes, "item.tsx"),
      "import { createFileRoute } from '@tanstack/react-router'; throw new Error('route module executed'); export const Route = createFileRoute('/item')({});\n",
    );
    writeFileSync(
      path.join(repository, "apps/web/tsr.config.json"),
      JSON.stringify({ virtualRouteConfig: "virtual-config.ts" }),
    );
    writeFileSync(
      path.join(repository, "apps/web/virtual-config.ts"),
      `await Bun.write(${JSON.stringify(marker)}, 'executed'); export default {};`,
    );
    const revision = commit();
    const reference = path.join(repository, "apps/web/src/routeTree.gen.ts");
    const referenceConfig = getConfig(
      { routesDirectory: routes, generatedRouteTree: reference },
      repository,
    );
    await new Generator({ config: referenceConfig, root: repository }).run();
    const expected = readFileSync(reference, "utf-8");
    // The projection comes from the requested revision, not dirty checkout data.
    writeFileSync(
      path.join(routes, "dirty.tsx"),
      "import { createFileRoute } from '@tanstack/react-router'; export const Route = createFileRoute('/dirty')({});\n",
    );
    const output = path.join(repository, "projection.ts");
    await generateRevisionRouteTree({ repository, revision, output });
    const first = readFileSync(output, "utf-8");
    expect(first).toBe(expected);
    expect(first).toContain("'/item'");
    expect(first).not.toContain("'/dirty'");
    expect(existsSync(marker)).toBe(false);
    await generateRevisionRouteTree({ repository, revision, output });
    expect(readFileSync(output, "utf-8")).toBe(first);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test.each(["virtual", "symlink"])(
  "untrusted %s entries fail before generator execution",
  (kind) => {
    const { repository, routes, commit } = fixture();
    try {
      const marker = path.join(repository, "executed");
      if (kind === "virtual") {
        writeFileSync(
          path.join(routes, "__virtual.ts"),
          `await Bun.write(${JSON.stringify(marker)}, 'executed'); export default [];`,
        );
      } else {
        symlinkSync("/etc/passwd", path.join(routes, "linked.tsx"));
      }
      const revision = commit();
      const result = Bun.spawnSync([
        "bun",
        path.join(import.meta.dirname, "network-baseline-route-tree.ts"),
        repository,
        revision,
        path.join(repository, "projection.ts"),
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        kind === "virtual"
          ? "virtual route configuration cannot be evaluated"
          : "only regular files",
      );
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(path.join(repository, "projection.ts"))).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);
