import { describe, expect, test } from "bun:test";

type DockerStage = {
  body: string;
  name: string;
  parent: string;
  platform: string | undefined;
};

const dockerfilePath = new URL("../apps/web/Dockerfile", import.meta.url);
const dockerfile = await Bun.file(dockerfilePath).text();
const stages = parseStages(dockerfile);
const stagesByName = new Map(stages.map((stage) => [stage.name, stage]));

describe("web container platform boundary", () => {
  test("runs the JavaScript toolchain on the native build platform", () => {
    for (const stageName of ["install-inputs", "pruner", "deps", "builder"]) {
      expect(resolvePlatform(stageName)).toBe("$BUILDPLATFORM");
    }

    const compilerStage = stages.find((stage) =>
      stage.body.includes("bun --filter @stll/web build"),
    );
    expect(compilerStage?.name).toBe("builder");
    expect(resolvePlatform(compilerStage?.name ?? "")).toBe("$BUILDPLATFORM");
  });

  test("installs production native dependencies for the target runtime", () => {
    expect(resolvePlatform("deps-prod")).toBe("$TARGETPLATFORM");
    expect(resolvePlatform("runner")).toBe("$TARGETPLATFORM");
    expect(stagesByName.get("deps-prod")?.body).toContain(
      "bun install --filter @stll/web --production",
    );
  });

  test("copies only architecture-independent build output across platforms", () => {
    const runner = stagesByName.get("runner");
    expect(runner?.parent).toBe("deps-prod");
    expect(runner?.body).toContain(
      "COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist",
    );
    expect(runner?.body).not.toMatch(/--from=builder .*node_modules/u);

    const crossPlatformCopies = stages.flatMap((stage) => {
      const destinationPlatform = resolvePlatform(stage.name);
      return stage.body
        .split("\n")
        .filter((line) => line.startsWith("COPY "))
        .flatMap((line) => {
          const sourceName = /--from=([^\s]+)/u.exec(line)?.at(1);
          if (!sourceName || !stagesByName.has(sourceName)) {
            return [];
          }
          if (resolvePlatform(sourceName) === destinationPlatform) {
            return [];
          }
          return [`${stage.name}: ${line}`];
        });
    });
    expect(crossPlatformCopies).toEqual([
      "deps-prod: COPY --from=install-inputs /json/ .",
      "runner: COPY --chown=stella:stella --from=pruner /app/out/json/ .",
      ...runtimeWorkspacePaths.map(
        (workspacePath) =>
          `runner: COPY --chown=stella:stella --from=pruner /app/out/full/${workspacePath}/src ./${workspacePath}/src`,
      ),
      "runner: COPY --chown=stella:stella --from=builder /app/apps/web/start-runtime.js ./apps/web/start-runtime.js",
      "runner: COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist",
    ]);
  });

  test("ships only the workspace source required by external runtime packages", () => {
    const runner = stagesByName.get("runner");
    expect(runner?.body).not.toContain("/app/out/full/ .");
    expect(runner?.body).toContain(
      "COPY --chown=stella:stella --from=pruner /app/out/json/ .",
    );
    expect(runner?.body).toContain(
      'await import("@stll/folio-core/docx/xmlParser")',
    );
    expect(runner?.body).toContain(
      'await import("@stll/folio-core/prosemirror/plugins/templateDirectives")',
    );
  });

  test("uses the same pinned multi-architecture base for build and runtime", () => {
    const buildBase = stagesByName.get("build-base");
    const runtimeBase = stagesByName.get("runtime-base");
    expect(buildBase?.parent).toBe(runtimeBase?.parent);
    expect(buildBase?.parent).toContain("@sha256:");
  });
});

function parseStages(source: string): DockerStage[] {
  const parsed: DockerStage[] = [];
  let current: DockerStage | undefined;

  for (const line of source.split("\n")) {
    const from =
      /^FROM(?:\s+--platform=(\S+))?\s+(\S+)\s+AS\s+(\S+)\s*$/iu.exec(line);
    if (from) {
      current = {
        body: "",
        name: from.at(3) ?? "",
        parent: from.at(2) ?? "",
        platform: from.at(1),
      };
      parsed.push(current);
      continue;
    }

    if (current) {
      current.body += `${line}\n`;
    }
  }

  return parsed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDependencyNames = (manifest: unknown): string[] => {
  if (!isRecord(manifest)) {
    return [];
  }

  const dependencies = manifest["dependencies"];
  return isRecord(dependencies) ? Object.keys(dependencies) : [];
};

type ResolvedPackage = {
  dependencyNames: string[];
  workspacePath: string | undefined;
};

const findExternalRuntimeWorkspacePaths = (source: unknown): string[] => {
  if (!isRecord(source)) {
    throw new TypeError("bun.lock must contain an object");
  }

  const packages = source["packages"];
  const workspaces = source["workspaces"];
  if (!isRecord(packages) || !isRecord(workspaces)) {
    throw new TypeError("bun.lock must contain packages and workspaces maps");
  }

  const resolvePackage = (name: string): ResolvedPackage | undefined => {
    const entry = packages[name];
    if (!Array.isArray(entry)) {
      return undefined;
    }

    const resolution = entry.at(0);
    if (typeof resolution !== "string") {
      throw new TypeError(`bun.lock package ${name} has no resolution`);
    }

    const workspaceMarker = "@workspace:";
    const markerIndex = resolution.indexOf(workspaceMarker);
    if (markerIndex !== -1) {
      const workspacePath = resolution.slice(
        markerIndex + workspaceMarker.length,
      );
      return {
        dependencyNames: readDependencyNames(workspaces[workspacePath]),
        workspacePath,
      };
    }

    return {
      dependencyNames: readDependencyNames(entry.at(2)),
      workspacePath: undefined,
    };
  };

  const webWorkspace = workspaces["apps/web"];
  const queue = readDependencyNames(webWorkspace).filter(
    (name) => resolvePackage(name)?.workspacePath === undefined,
  );
  const visited = new Set<string>();
  const runtimeWorkspaces = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || visited.has(name)) {
      continue;
    }
    visited.add(name);

    const resolved = resolvePackage(name);
    if (!resolved) {
      continue;
    }
    if (resolved.workspacePath) {
      runtimeWorkspaces.add(resolved.workspacePath);
    }
    queue.push(...resolved.dependencyNames);
  }

  return [...runtimeWorkspaces].sort();
};

const lockfilePath = new URL("../bun.lock", import.meta.url);
const runtimeWorkspacePaths = findExternalRuntimeWorkspacePaths(
  Bun.JSONC.parse(await Bun.file(lockfilePath).text()),
);

function resolvePlatform(stageName: string, seen = new Set<string>()): string {
  if (seen.has(stageName)) {
    throw new Error(`Docker stage cycle at ${stageName}`);
  }
  seen.add(stageName);

  const stage = stagesByName.get(stageName);
  if (!stage) {
    throw new Error(`Unknown Docker stage: ${stageName}`);
  }
  if (stage.platform) {
    return stage.platform;
  }
  if (!stagesByName.has(stage.parent)) {
    throw new Error(`Docker stage ${stageName} has no explicit platform root`);
  }

  return resolvePlatform(stage.parent, seen);
}
