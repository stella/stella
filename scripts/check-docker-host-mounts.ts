import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const safeMountTypes = new Set(["volume", "tmpfs"]);
// Default-deny: local volume driver options outside this list can select a
// host path (type, o, device) or an unknown backend.
const safeDriverOptions = new Set(["size"]);
const isSafeDriverOptionKey = (key: string | undefined): boolean =>
  key !== undefined && safeDriverOptions.has(key.toLowerCase());

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
  isRecord(options) && Object.keys(options).every(isSafeDriverOptionKey);

// A driver option is unsafe unless it is a static key=value pair whose key is
// allowlisted.
const localVolumeDriver = "local";

// Takes unknown so a present non-string driver (parsed YAML) is unsafe.
const isUnsafeDriverName = (driver: unknown): boolean =>
  driver !== localVolumeDriver;

// Values of --volume-driver (selects the driver for -v volumes) in an
// argument list; undefined when a value cannot be resolved.
const volumeDriverFlags = (
  args: readonly (string | undefined)[],
): string[] | undefined => {
  const drivers: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--volume-driver") {
      const value = args[(index += 1)];
      if (value === undefined) {
        return undefined;
      }
      drivers.push(value);
    } else if (arg?.startsWith("--volume-driver=") === true) {
      drivers.push(arg.slice("--volume-driver=".length));
    }
  }
  return drivers;
};

const hasSafeVolumeDriverFlags = (
  args: readonly (string | undefined)[],
): boolean => {
  const drivers = volumeDriverFlags(args);
  return drivers !== undefined && !drivers.some(isUnsafeDriverName);
};

type VolumeCreateFlags = { options: string[]; drivers: string[] };

const isUnsafeVolumeCreate = (flags: VolumeCreateFlags | undefined): boolean =>
  flags === undefined ||
  flags.options.some(isUnsafeDriverOption) ||
  flags.drivers.some(isUnsafeDriverName);

const isUnsafeDriverOption = (option: string): boolean => {
  const separator = option.indexOf("=");
  return separator === -1 || !isSafeDriverOptionKey(option.slice(0, separator));
};

// Normalizes every Docker spelling of the volume create driver option and
// driver flags (--opt X, --opt=X, -o X, -o=X, -oX, --driver X, -d X, and short
// flag clusters) into key=value strings and driver names. Arguments are static strings; only the last may be undefined (the
// volume name). Returns undefined when an option value cannot be resolved.
const volumeCreateOptions = (
  args: readonly (string | undefined)[],
): VolumeCreateFlags | undefined => {
  const options: string[] = [];
  const drivers: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      if (index < args.length - 1) {
        return undefined;
      }
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
      if (name !== "opt" && name !== "driver") {
        continue;
      }
      const value =
        separator === -1 ? args[(index += 1)] : arg.slice(separator + 1);
      if (value === undefined) {
        return undefined;
      }
      (name === "opt" ? options : drivers).push(value);
      continue;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    for (let at = 1; at < arg.length; at += 1) {
      const flag = arg[at];
      if (flag !== "o" && flag !== "d") {
        continue;
      }
      const rest = arg.slice(at + 1);
      const value = rest === "" ? args[(index += 1)] : rest.replace(/^=/u, "");
      if (value === undefined) {
        return undefined;
      }
      (flag === "o" ? options : drivers).push(value);
      break;
    }
  }
  return { options, drivers };
};

// Splits the remainder of a shell command line into words, joining adjacent
// quoted and unquoted parts; stops at a control operator.
const shellWords = (text: string): (string | undefined)[] => {
  const words: (string | undefined)[] = [];
  let current: string | undefined;
  let quote: string | undefined;
  let dynamic = false;
  const flush = () => {
    if (current !== undefined) {
      words.push(dynamic ? undefined : current);
    }
    current = undefined;
    dynamic = false;
  };
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current = (current ?? "") + char;
        // Single quotes are literal; double quotes still expand.
        dynamic ||= quote === '"' && (char === "$" || char === "`");
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current ??= "";
    } else if (/\s/u.test(char)) {
      flush();
    } else if (/[;&|)<>]/u.test(char)) {
      flush();
      return words;
    } else {
      current = (current ?? "") + char;
      dynamic ||= char === "$" || char === "`";
    }
  }
  flush();
  return words;
};

const NAME_HELPERS: ReadonlySet<string> = new Set([
  "dockerVolumeName",
  "dockerContainerName",
  "dockerImageRef",
]);

// Local name under which the file imports the validated-name helper.
const importedNameHelpers = (tree: ts.SourceFile): ReadonlySet<string> => {
  const local = new Set<string>();
  for (const statement of tree.statements) {
    const bindings =
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      if (NAME_HELPERS.has((specifier.propertyName ?? specifier.name).text)) {
        local.add(specifier.name.text);
      }
    }
  }
  return local;
};

// A mount string template is checkable only when every interpolation is a
// call to the imported helper; each is replaced by a placeholder volume name.
// Any other interpolation stays as raw `${` text, which inspectMountOptions
// rejects.
const mountTemplateText = (
  template: ts.TemplateExpression,
  tree: ts.SourceFile,
  helpers: ReadonlySet<string>,
): string => {
  const calls = template.templateSpans.every(({ expression }) =>
    isVolumeNameHelperCall(expression, helpers),
  );
  if (!calls) {
    return template.getText(tree).slice(1, -1);
  }
  return (
    template.head.text +
    template.templateSpans
      .map(({ literal }) => `volume${literal.text}`)
      .join("")
  );
};

const inspectMountOptions = (mount: string): boolean => {
  // Shell expansions and template interpolations are unresolved values.
  if (/[$`]/u.test(mount)) {
    return false;
  }
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
  if (
    options.some(
      ({ key, value }) =>
        (key === "volume-opt" && isUnsafeDriverOption(value)) ||
        (key === "volume-driver" && isUnsafeDriverName(value)),
    )
  ) {
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
    return driverConfig.properties.every((driverProperty) => {
      if (!ts.isPropertyAssignment(driverProperty)) {
        return false;
      }
      const driverPropertyName = staticPropertyName(driverProperty.name);
      if (driverPropertyName === "Name") {
        return (
          ts.isStringLiteralLike(driverProperty.initializer) &&
          !isUnsafeDriverName(driverProperty.initializer.text)
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
            isSafeDriverOptionKey(staticPropertyName(option.name)),
        )
      );
    });
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
      // Local volume driver options can back a volume with a host path.
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
  const volumes = isRecord(document) ? document.volumes : undefined;
  if (isRecord(volumes)) {
    for (const [name, volume] of Object.entries(volumes)) {
      if (
        isRecord(volume) &&
        volume.driver !== undefined &&
        isUnsafeDriverName(volume.driver)
      ) {
        failures.push(`compose.volumes.${name}: only the local volume driver`);
      }
    }
  }
  return failures;
};

const staticArgument = (
  element: ts.Expression | undefined,
): string | undefined =>
  element !== undefined && ts.isStringLiteralLike(element)
    ? element.text
    : undefined;

const isVolumeNameHelperCall = (
  expression: ts.Expression,
  helpers: ReadonlySet<string>,
): boolean =>
  ts.isCallExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  helpers.has(expression.expression.text);

const helperCallPlaceholder = (
  element: ts.Expression,
  helpers: ReadonlySet<string>,
): string | undefined =>
  isVolumeNameHelperCall(element, helpers) ? "volume" : undefined;

// Argument arrays: ["docker", "volume", "create", ...] or, when the command is
// a separate spawn argument, ["volume", "create", ...].
const hasSafeVolumeCreateArguments = (
  array: ts.ArrayLiteralExpression,
  helpers: ReadonlySet<string>,
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
  // Every argument after create must be a literal or a validated-name call.
  const args = elements
    .slice(start + 2)
    .map(
      (element) =>
        staticArgument(element) ?? helperCallPlaceholder(element, helpers),
    );
  return (
    args.every((argument) => argument !== undefined) &&
    !isUnsafeVolumeCreate(volumeCreateOptions(args))
  );
};

const runValueFlags = new Set([
  "--add-host",
  "--cap-add",
  "--cap-drop",
  "--cgroupns",
  "--cidfile",
  "--cpus",
  "--device",
  "--dns",
  "--entrypoint",
  "--env",
  "--env-file",
  "--expose",
  "--group-add",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-period",
  "--health-timeout",
  "--hostname",
  "--ip",
  "--ipc",
  "--label",
  "--log-driver",
  "--log-opt",
  "--memory",
  "--mount",
  "--name",
  "--net",
  "--network",
  "--pid",
  "--platform",
  "--publish",
  "--pull",
  "--restart",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--sysctl",
  "--tmpfs",
  "--ulimit",
  "--user",
  "--volume",
  "--volume-driver",
  "--workdir",
  "-e",
  "-h",
  "-l",
  "-m",
  "-p",
  "-u",
  "-v",
  "-w",
]);
const runBooleanFlags = new Set([
  "--detach",
  "--init",
  "--interactive",
  "--privileged",
  "--publish-all",
  "--read-only",
  "--rm",
  "--tty",
  "--no-healthcheck",
  "--oom-kill-disable",
]);

// Every word before the image must be a resolved literal; the image and the
// command after it may be dynamic. An unknown flag could take a value, so it
// fails closed.
const hasResolvedRunOptions = (
  args: readonly (string | undefined)[],
): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return false;
    }
    if (!arg.startsWith("-")) {
      return true;
    }
    if (
      arg.includes("=") ||
      runBooleanFlags.has(arg) ||
      /^-[ditP]+$/u.test(arg)
    ) {
      continue;
    }
    if (!runValueFlags.has(arg) || args[(index += 1)] === undefined) {
      return false;
    }
  }
  return true;
};

const resolvedRunArgument = (
  element: ts.Expression,
  helpers: ReadonlySet<string>,
): string | undefined => {
  const literal = staticArgument(element);
  if (isVolumeNameHelperCall(element, helpers)) {
    return "name";
  }
  if (literal !== undefined || !ts.isTemplateExpression(element)) {
    return literal;
  }
  return element.templateSpans.every(({ expression }) =>
    isVolumeNameHelperCall(expression, helpers),
  )
    ? element.head.text +
        element.templateSpans
          .map(({ literal: text }) => `volume${text.text}`)
          .join("")
    : undefined;
};

const dockerRunArray = (array: ts.ArrayLiteralExpression): number => {
  const { elements } = array;
  const start = elements.findIndex(
    (element) => staticArgument(element) === "docker",
  );
  const offset = start === -1 ? 0 : start + 1;
  const first = staticArgument(elements[offset]);
  const verbOffset = first === "container" ? offset + 1 : offset;
  const verb = staticArgument(elements[verbOffset]);
  return verb === "run" || verb === "create" ? verbOffset + 1 : -1;
};

const volumeCreateArrayFailures = (
  array: ts.ArrayLiteralExpression,
  helpers: ReadonlySet<string>,
): string[] => {
  const failures: string[] = [];
  if (!hasSafeVolumeCreateArguments(array, helpers)) {
    failures.push("Docker volume driver options cannot configure host binds");
  }
  if (!hasSafeVolumeDriverFlags(array.elements.map(staticArgument))) {
    failures.push("Only the local volume driver is allowed");
  }
  const runStart = dockerRunArray(array);
  if (
    runStart !== -1 &&
    !hasResolvedRunOptions(
      array.elements
        .slice(runStart)
        .map((element) => resolvedRunArgument(element, helpers)),
    )
  ) {
    failures.push("Docker run options must be statically resolvable");
  }
  return failures;
};

export const inspectDockerHelper = (source: string): string[] => {
  const failures: string[] = [];
  // Shell helpers are also discovered. Join continuations before checking
  // Docker command lines; TypeScript parsing alone does not see shell flags.
  const commands = source.replaceAll(/\\\r?\n/gu, " ");
  for (const line of commands.split("\n")) {
    const create = /\bdocker\s+volume\s+create\b/u.exec(line);
    if (create !== null) {
      const words = shellWords(line.slice(create.index + create[0].length));
      const flags = words.includes(undefined)
        ? undefined
        : volumeCreateOptions(words);
      if (isUnsafeVolumeCreate(flags)) {
        failures.push(
          "Docker volume driver options cannot configure host binds",
        );
      }
    }
    const run = /\bdocker\s+(?:container\s+)?(?:run|create)\b/u.exec(line);
    if (run === null) {
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
      /--mount(?:\s+|=)\S*[$`]/u.test(line) ||
      !hasResolvedRunOptions(
        shellWords(line.slice(run.index + run[0].length)),
      ) ||
      !hasSafeVolumeDriverFlags(shellWords(line)) ||
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
  const helpers = importedNameHelpers(tree);
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
      failures.push(...volumeCreateArrayFailures(node, helpers));
      for (const [index, element] of node.elements.entries()) {
        if (!ts.isStringLiteralLike(element) || element.text !== "--mount") {
          continue;
        }
        const argument = node.elements[index + 1];
        let mount: string | undefined;
        if (argument && ts.isStringLiteralLike(argument)) {
          mount = argument.text;
        } else if (argument && ts.isTemplateExpression(argument)) {
          mount = mountTemplateText(argument, tree, helpers);
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
