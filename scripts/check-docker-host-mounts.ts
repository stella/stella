import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const safeMountTypes = new Set(["volume", "tmpfs"]);
const hostBackedDriverOptions = new Set(["type", "o", "device"]);

const staticPropertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteralLike(name.expression)
      ? name.expression.text
      : undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
};

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

const hasSafeDriverOptions = (options: unknown): boolean =>
  isRecord(options) &&
  Object.keys(options).every(
    (key) => !hostBackedDriverOptions.has(key.toLowerCase()),
  );

const inspectMountOptions = (mount: string): boolean => {
  const options = mount.split(",").map((option) => {
    const separator = option.indexOf("=");
    return {
      key: (separator === -1 ? option : option.slice(0, separator))
        .trim()
        .toLowerCase(),
      value: separator === -1 ? "" : option.slice(separator + 1).trim(),
    };
  });
  const types = options.filter(({ key }) => key === "type");
  if (
    types.length === 0 ||
    types.some(({ value }) => !safeMountTypes.has(value.toLowerCase()))
  ) {
    return false;
  }
  if (options.some(({ key }) => key === "bind-propagation")) {
    return false;
  }
  const finalType = types.at(-1)?.value.toLowerCase();
  return !options.some(
    ({ key, value }) =>
      (key === "source" || key === "src") &&
      finalType !== "volume" &&
      /^(?:[/.~]|[a-zA-Z]:[\\/])/u.test(value),
  );
};

const propertyAssignment = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined =>
  object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      staticPropertyName(property.name) === name,
  );

const hasSafeApiDriverConfig = (volumeOptions: ts.Expression): boolean => {
  if (!ts.isObjectLiteralExpression(volumeOptions)) {
    return false;
  }
  return volumeOptions.properties.every((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    if (staticPropertyName(property.name) !== "DriverConfig") {
      return staticPropertyName(property.name) !== undefined;
    }
    if (!ts.isObjectLiteralExpression(property.initializer)) {
      return false;
    }
    const driverConfig = property.initializer;
    return (
      driverConfig.properties.every((driverProperty) => {
        if (!ts.isPropertyAssignment(driverProperty)) {
          return false;
        }
        const driverPropertyName = staticPropertyName(driverProperty.name);
        if (driverPropertyName === "Name") {
          return (
            ts.isStringLiteralLike(driverProperty.initializer) &&
            driverProperty.initializer.text === "local"
          );
        }
        if (driverPropertyName !== "Options") {
          return false;
        }
        return (
          ts.isObjectLiteralExpression(driverProperty.initializer) &&
          driverProperty.initializer.properties.every(
            (option) =>
              ts.isPropertyAssignment(option) &&
              !hostBackedDriverOptions.has(
                staticPropertyName(option.name)?.toLowerCase() ?? "type",
              ),
          )
        );
      }) && propertyAssignment(driverConfig, "Name") !== undefined
    );
  });
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
      if (
        key === "driver_opts" &&
        ((value.driver !== undefined && value.driver !== "local") ||
          !hasSafeDriverOptions(entry))
      ) {
        failures.push(
          `${next}: host-backed volume driver options are forbidden`,
        );
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

// A driver option is host-backed when its key selects a bind, or when it is
// not a static key=value pair.
const isHostBackedDriverOption = (option: string): boolean => {
  const separator = option.indexOf("=");
  if (separator === -1) {
    return true;
  }
  return hostBackedDriverOptions.has(option.slice(0, separator).toLowerCase());
};

const staticArgument = (
  element: ts.Expression | undefined,
): string | undefined =>
  element !== undefined && ts.isStringLiteralLike(element)
    ? element.text
    : undefined;

// Argument arrays: ["docker", "volume", "create", ...] or, when the command is
// a separate spawn argument, ["volume", "create", ...]. Fails closed on an
// option position that is not statically resolvable.
const hasSafeVolumeCreateArguments = (
  array: ts.ArrayLiteralExpression,
): boolean => {
  const { elements } = array;
  const start = elements.findIndex(
    (element, index) =>
      staticArgument(element) === "volume" &&
      staticArgument(elements[index + 1]) === "create" &&
      (index === 0 || staticArgument(elements[index - 1]) === "docker"),
  );
  if (start === -1) {
    return true;
  }
  for (let index = start + 2; index < elements.length; index += 1) {
    const element = elements[index];
    if (element === undefined) {
      continue;
    }
    if (ts.isSpreadElement(element)) {
      return false;
    }
    const argument = staticArgument(element);
    if (argument === "--opt" || argument === "-o") {
      const option = staticArgument(elements[index + 1]);
      if (option === undefined || isHostBackedDriverOption(option)) {
        return false;
      }
      index += 1;
      continue;
    }
    const inline =
      argument === undefined ? null : /^(?:--opt|-o)=(.*)$/su.exec(argument);
    if (inline !== null && isHostBackedDriverOption(inline[1] ?? "")) {
      return false;
    }
  }
  return true;
};

const volumeCreateArrayFailures = (
  array: ts.ArrayLiteralExpression,
): string[] =>
  hasSafeVolumeCreateArguments(array)
    ? []
    : ["Docker volume driver options cannot configure host binds"];

export const inspectDockerHelper = (source: string): string[] => {
  const failures: string[] = [];
  // Shell helpers are also discovered. Join continuations before checking
  // Docker command lines; TypeScript parsing alone does not see shell flags.
  const commands = source.replaceAll(/\\\r?\n/gu, " ");
  for (const line of commands.split("\n")) {
    if (/\bdocker\s+volume\s+create\b/u.test(line)) {
      const volumeOptions = [
        ...line.matchAll(
          /(?:^|\s)(?:--opt|-o)(?:\s|=)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gu,
        ),
      ];
      if (
        volumeOptions.some((match) => {
          const option = match[1] ?? match[2] ?? match[3] ?? "";
          const separator = option.indexOf("=");
          if (separator === -1) {
            return true;
          }
          return hostBackedDriverOptions.has(
            option.slice(0, separator).toLowerCase(),
          );
        })
      ) {
        failures.push(
          "Docker volume driver options cannot configure host binds",
        );
      }
    }
    if (!/\bdocker\s+(?:container\s+)?(?:run|create)\b/u.test(line)) {
      continue;
    }
    const mountArguments = [
      ...line.matchAll(
        /(?:^|\s)--mount(?:\s|=)(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s"'`]+))/gu,
      ),
    ];
    if (
      /(?:^|[\s"'`])(?:-v[^\s]*|--volume(?:\s|=))/u.test(line) ||
      (mountArguments.length === 0 && /(?:^|\s)--mount(?:\s|=)/u.test(line)) ||
      mountArguments.some(
        (match) =>
          !inspectMountOptions(
            match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
          ),
      )
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
        !inspectMountOptions(value.slice("--mount=".length))
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
      staticPropertyName(node.name)?.toLowerCase() === "type" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text.toLowerCase() === "bind"
    ) {
      failures.push("Docker API bind Mounts are forbidden");
    }
    if (
      ts.isPropertyAssignment(node) &&
      staticPropertyName(node.name) === "Mounts"
    ) {
      const mounts = node.initializer;
      const safe =
        ts.isArrayLiteralExpression(mounts) &&
        mounts.elements.every(
          (mount) =>
            ts.isObjectLiteralExpression(mount) &&
            mount.properties.every((property) => {
              if (!ts.isPropertyAssignment(property)) {
                return false;
              }
              const name = staticPropertyName(property.name);
              if (name === undefined) {
                return false;
              }
              if (name === "Type") {
                return (
                  ts.isStringLiteralLike(property.initializer) &&
                  safeMountTypes.has(property.initializer.text)
                );
              }
              if (name === "VolumeOptions") {
                return hasSafeApiDriverConfig(property.initializer);
              }
              return true;
            }) &&
            mount.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                staticPropertyName(property.name) === "Type" &&
                ts.isStringLiteralLike(property.initializer) &&
                safeMountTypes.has(property.initializer.text),
            ),
        );
      if (!safe) {
        failures.push(
          "Docker API Mounts require explicit volume or tmpfs types",
        );
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      failures.push(...volumeCreateArrayFailures(node));
      for (const [index, element] of node.elements.entries()) {
        if (!ts.isStringLiteralLike(element) || element.text !== "--mount") {
          continue;
        }
        const argument = node.elements[index + 1];
        let mount: string | undefined;
        if (argument && ts.isStringLiteralLike(argument)) {
          mount = argument.text;
        } else if (argument && ts.isTemplateExpression(argument)) {
          mount = argument.getText(tree).slice(1, -1);
        }
        if (!mount || !inspectMountOptions(mount)) {
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
