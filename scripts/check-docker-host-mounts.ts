import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

const isContainerVolumeMount = (mount: unknown): boolean => {
  if (typeof mount === "string") {
    const parts = mount.split(":");
    return (
      (parts.length === 1 && mount.startsWith("/")) ||
      (parts.length >= 2 &&
        volumeName.test(parts[0] ?? "") &&
        parts[1]?.startsWith("/") === true)
    );
  }
  if (!isRecord(mount)) {
    return false;
  }
  return (
    mount.type === "tmpfs" ||
    (mount.type === "volume" &&
      (mount.source === undefined ||
        (typeof mount.source === "string" && volumeName.test(mount.source))))
  );
};

// Short syntax interpolations can resolve to host paths. Require a literal
// Docker volume name; long syntax must explicitly select volume or tmpfs.
export const inspectComposeMounts = (source: string): string[] => {
  const document: unknown = Bun.YAML.parse(source);
  const failures: string[] = [];
  const visited = new WeakSet<object>();
  const visit = (value: unknown, location: string) => {
    if (typeof value === "object" && value !== null) {
      if (visited.has(value)) {
        return;
      }
      visited.add(value);
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        visit(entry, `${location}[${index}]`);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const next = `${location}.${key}`;
      if (key === "volumes" && Array.isArray(entry)) {
        for (const mount of entry) {
          if (isContainerVolumeMount(mount)) {
            continue;
          }
          failures.push(`${next}: host or unresolved mount source`);
        }
      }
      // Local volume driver options can disguise host binds as named volumes.
      if (key === "driver_opts") {
        failures.push(`${next}: custom volume driver options require review`);
      }
      if ((key === "configs" || key === "secrets") && isRecord(entry)) {
        for (const [name, config] of Object.entries(entry)) {
          if (isRecord(config) && "file" in config) {
            failures.push(`${next}.${name}: host file mount`);
          }
        }
      }
      visit(entry, next);
    }
  };
  visit(document, "compose");
  return failures;
};

export const inspectDockerHelper = (source: string): string[] => {
  const failures: string[] = [];
  // Shell helpers are also discovered. Join continuations before checking
  // Docker command lines; TypeScript parsing alone does not see shell flags.
  const commands = source.replaceAll(/\\\r?\n/gu, " ");
  for (const line of commands.split("\n")) {
    if (!/\bdocker\s+(?:container\s+)?(?:run|create)\b/u.test(line)) {
      continue;
    }
    if (
      /(?:^|[\s"'`])(?:-v[^\s]*|--volume(?:\s|=))/u.test(line) ||
      /(?:^|\s)--mount(?:\s|=)(?!["']?type=(?:volume|tmpfs),)/u.test(line)
    ) {
      failures.push(
        "Shell Docker mounts require explicit type=volume or type=tmpfs",
      );
    }
  }
  if (
    /\bBinds\b/u.test(source) ||
    /["'](?:Type|type)["']\s*:\s*["']bind["']/u.test(source)
  ) {
    failures.push("Docker API bind configuration is forbidden");
  }
  const tree = ts.createSourceFile(
    "helper.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const value = ts.isTemplateExpression(node)
        ? node.getText(tree)
        : node.text;
      if (
        value.startsWith("--mount=") &&
        !/^--mount=type=(?:volume|tmpfs),/u.test(value)
      ) {
        failures.push("--mount requires explicit type=volume or type=tmpfs");
      }
      if (
        /\btype\s*=\s*bind\b/iu.test(value) ||
        /\bType["']?\s*:\s*["']bind\b/iu.test(value)
      ) {
        failures.push("Docker bind mount is forbidden");
      }
      if (
        /^-v/u.test(value) ||
        /^(?:--volume)(?:=|$)/u.test(value) ||
        /(?:^|[\s"'`])(?:-v[^\s]*|--volume(?:\s|=))/u.test(value)
      ) {
        failures.push(
          "Use explicit --mount type=volume instead of ambiguous -v/--volume",
        );
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree).replaceAll(/["']/gu, "").toLowerCase() ===
        "type" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text.toLowerCase() === "bind"
    ) {
      failures.push("Docker API bind Mounts are forbidden");
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree).replaceAll(/["']/gu, "") === "Mounts"
    ) {
      const mounts = node.initializer;
      const safe =
        ts.isArrayLiteralExpression(mounts) &&
        mounts.elements.every(
          (mount) =>
            ts.isObjectLiteralExpression(mount) &&
            mount.properties.every(
              (property) =>
                ts.isPropertyAssignment(property) &&
                (property.name.getText(tree).replaceAll(/["']/gu, "") !==
                  "Type" ||
                  (ts.isStringLiteralLike(property.initializer) &&
                    ["volume", "tmpfs"].includes(property.initializer.text))),
            ) &&
            mount.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(tree).replaceAll(/["']/gu, "") ===
                  "Type" &&
                ts.isStringLiteralLike(property.initializer) &&
                ["volume", "tmpfs"].includes(property.initializer.text),
            ),
        );
      if (!safe) {
        failures.push(
          "Docker API Mounts require explicit volume or tmpfs types",
        );
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const [index, element] of node.elements.entries()) {
        if (!ts.isStringLiteralLike(element) || element.text !== "--mount") {
          continue;
        }
        const argument = node.elements[index + 1];
        let mount: string | undefined;
        if (argument && ts.isStringLiteralLike(argument)) {
          mount = argument.text;
        } else if (argument && ts.isTemplateExpression(argument)) {
          mount = argument.head.text;
        }
        if (!mount || !/^type=(?:volume|tmpfs),/u.test(mount)) {
          failures.push("--mount requires explicit type=volume or type=tmpfs");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return failures;
};

export const isDockerMountGuardCandidate = (file: string): boolean =>
  /(?:^|\/)[^/]*compose[^/]*\.ya?ml$/iu.test(file) ||
  (!/\.(?:test|spec)\./u.test(file) &&
    /\.(?:ts|tsx|js|mjs|sh|py)$/u.test(file) &&
    (/^(?:apps\/api\/scripts\/|packages\/scripts\/src\/)/u.test(file) ||
      /(?:corpus|suite)/iu.test(file)));

export const isDockerMountGuardInput = (
  file: string,
  source: string,
): boolean =>
  /(?:^|\/)[^/]*compose[^/]*\.ya?ml$/iu.test(file) ||
  file === "packages/scripts/src/dev-runner.ts" ||
  (isDockerMountGuardCandidate(file) && /docker/iu.test(source));

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  const status = childExitStatus(tracked);
  if (status !== 0) {
    process.exit(status);
  }
  const failures: string[] = [];
  for (const file of tracked.stdout.toString().split("\0")) {
    if (!isDockerMountGuardCandidate(file)) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    if (!isDockerMountGuardInput(file, source)) {
      continue;
    }
    const issues = /\.ya?ml$/u.test(file)
      ? inspectComposeMounts(source)
      : inspectDockerHelper(source);
    for (const issue of issues) {
      failures.push(`${file}: ${issue}`);
    }
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Docker host mount guard passed");
}
