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
    for (const stage of stages) {
      const runsBun = logicalInstructions(stage.body).some(
        (instruction) =>
          instruction.startsWith("RUN ") && /\bbun\b/u.test(instruction),
      );
      if (runsBun) {
        expect(resolvePlatform(stage.name)).toBe("$BUILDPLATFORM");
      }
    }

    const compilerStage = stages.find((stage) =>
      stage.body.includes("bun --filter @stll/web build"),
    );
    expect(compilerStage?.name).toBe("builder");
    expect(resolvePlatform(compilerStage?.name ?? "")).toBe("$BUILDPLATFORM");
  });

  test("selects target-native dependencies without emulating Bun", () => {
    expect(resolvePlatform("runner")).toBe("$TARGETPLATFORM");
    const productionDependencies = stagesByName.get("deps-prod")?.body;
    expect(productionDependencies).toContain("ARG TARGETARCH");
    const architectureMapping = Object.fromEntries(
      [
        ...(productionDependencies?.matchAll(
          /\b([a-z0-9_]+)\)\s+target_cpu=([a-z0-9_]+)\s+;;/gu,
        ) ?? []),
      ].map((match) => [match.at(1), match.at(2)]),
    );
    expect(architectureMapping).toEqual({ amd64: "x64", arm64: "arm64" });
    expect(productionDependencies).toMatch(/\*\).*?\bexit 1\s+;;/su);
    expect(productionDependencies).toContain(
      "bun install --filter @stll/web --production",
    );
    expect(productionDependencies).toMatch(
      /--cpu="\$\{target_cpu\}" --os=linux/u,
    );

    const runner = stagesByName.get("runner");
    expect(runner?.parent).toBe("runtime-base");
    expect(runner?.body).toContain("COPY --from=deps-prod /app/ .");
  });

  test("copies only architecture-independent build output across platforms", () => {
    const runner = stagesByName.get("runner");
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
      "runner: COPY --from=deps-prod /app/ .",
      "runner: COPY --chown=stella:stella --from=pruner /app/out/json/ .",
      "runner: COPY --chown=stella:stella --from=builder /app/web-runtime-stage/ .",
      "runner: COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist",
    ]);
  });

  test("seals the runtime against workspace TypeScript source", () => {
    const builder = stagesByName.get("builder");
    expect(builder?.body).toContain(
      "bun scripts/stage-web-runtime.ts /app/web-runtime-stage --install-build-deps",
    );
    // The committed lockfile and root manifest drive the staged closure and
    // its install; Turbo's pruned approximations in out/full must not.
    expect(builder?.body).toContain(
      "COPY --from=install-inputs /json/bun.lock /json/package.json ./",
    );

    const runner = stagesByName.get("runner");
    // The pruned source tree (out/full) belongs to the build stages only; the
    // runtime gets manifests, the staged dist closure, the server entry, and
    // dist/.
    expect(runner?.body).not.toContain("out/full");
    expect(runner?.body).toContain(
      "COPY --chown=stella:stella --from=pruner /app/out/json/ .",
    );
    expect(runner?.body).toContain(
      "COPY --chown=stella:stella --from=builder /app/web-runtime-stage/ .",
    );
    expect(runner?.body).toContain("COPY --from=deps-prod /app/ .");
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

function logicalInstructions(body: string): string[] {
  const instructions: string[] = [];
  let current = "";

  for (const line of body.split("\n")) {
    current += `${current ? " " : ""}${line.trim()}`;
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    if (current) {
      instructions.push(current);
    }
    current = "";
  }

  return instructions;
}

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
