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
      .map(({ literal }) => `volume-name${literal.text}`)
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
      // Inherits another container's mounts, bind mounts included.
      if (key === "volumes_from") {
        failures.push(`${next}: inherited volumes are forbidden`);
      }
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

const RUN_OPTIONS_MESSAGE =
  "Docker run options must be allowlisted, resolved flags (--volumes-from is not allowed)";

// Default-deny allowlist of docker run/create flags. Any other flag, such as
// --volumes-from (inherits another container's mounts), fails closed.
const runValueFlags = new Set([
  "--entrypoint",
  "--env",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-period",
  "--health-timeout",
  "--label",
  "--mount",
  "--name",
  "--network",
  "--publish",
  "--volume",
  "--volume-driver",
  "--workdir",
]);
const runBooleanFlags = new Set(["--detach", "--rm"]);
const runShortValueFlags = new Set(["e", "l", "p", "v", "w"]);
const runShortBooleanFlags = new Set(["d"]);

// Words consumed by a docker run flag: 0 for an unknown flag, 2 when the
// value is the next word.
const runFlagWidth = (arg: string): number => {
  if (arg.startsWith("--")) {
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg : arg.slice(0, separator);
    if (runValueFlags.has(name)) {
      return separator === -1 ? 2 : 1;
    }
    return runBooleanFlags.has(name) ? 1 : 0;
  }
  // Clustered short flags (-dv) can hide a value flag: only a lone boolean or
  // a value flag with its attached value is accepted.
  const flag = arg.charAt(1);
  if (runShortValueFlags.has(flag)) {
    return arg.length === 2 ? 2 : 1;
  }
  return runShortBooleanFlags.has(flag) && arg.length === 2 ? 1 : 0;
};

// Every word before the image must be a resolved, allowlisted flag; the image
// and the command after it may be dynamic.
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
    const width = runFlagWidth(arg);
    if (width === 0 || (width === 2 && args[index + 1] === undefined)) {
      return false;
    }
    index += width - 1;
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

const dockerValueGlobals = new Set([
  "--config",
  "--context",
  "--host",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const dockerBooleanGlobals = new Set([
  "--debug",
  "--help",
  "--tls",
  "--tlsverify",
  "--version",
]);

// Words consumed by a Docker global option: 0 for an unknown option, 2 when
// the value is the next word.
const dockerGlobalWidth = (arg: string): number => {
  if (arg.startsWith("--")) {
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg : arg.slice(0, separator);
    if (dockerValueGlobals.has(name)) {
      return separator === -1 ? 2 : 1;
    }
    return dockerBooleanGlobals.has(name) ? 1 : 0;
  }
  const flag = arg.charAt(1);
  if (flag === "c" || flag === "H" || flag === "l") {
    return arg.length === 2 ? 2 : 1;
  }
  return flag === "D" && arg.length === 2 ? 1 : 0;
};

type DockerCommand =
  | { kind: "run"; args: (string | undefined)[] }
  | { kind: "volume-create"; args: (string | undefined)[] }
  | "unresolved"
  | undefined;

// Words after `docker`: skips global options, then dispatches on the
// subcommand. An unknown global option or an unresolved word before the
// subcommand fails closed.
const parseDockerCommand = (args: (string | undefined)[]): DockerCommand => {
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return "unresolved";
    }
    if (!arg.startsWith("-")) {
      break;
    }
    const width = dockerGlobalWidth(arg);
    if (width === 0 || (width === 2 && args[index + 1] === undefined)) {
      return "unresolved";
    }
    index += width - 1;
  }
  const rest = args.slice(index + 1);
  switch (args[index]) {
    case "run":
    case "create":
      return { kind: "run", args: rest };
    case "container":
      if (rest.length > 0 && rest[0] === undefined) {
        return "unresolved";
      }
      return rest[0] === "run" || rest[0] === "create"
        ? { kind: "run", args: rest.slice(1) }
        : undefined;
    case "volume":
      if (rest.length > 0 && rest[0] === undefined) {
        return "unresolved";
      }
      return rest[0] === "create"
        ? { kind: "volume-create", args: rest.slice(1) }
        : undefined;
    default:
      return undefined;
  }
};

const dockerSubcommands = new Set(["run", "create", "volume", "container"]);

// ["docker", ...globals, "volume", "create", ...] or, when the command is a
// separate spawn argument, an array that starts at the globals or subcommand.
const arrayDockerCommand = (
  array: ts.ArrayLiteralExpression,
  helpers: ReadonlySet<string>,
): DockerCommand => {
  const resolved = array.elements.map((element) =>
    resolvedRunArgument(element, helpers),
  );
  const docker = resolved.indexOf("docker");
  if (docker !== -1) {
    return parseDockerCommand(resolved.slice(docker + 1));
  }
  const first = resolved[0];
  return first !== undefined &&
    (dockerSubcommands.has(first) || dockerGlobalWidth(first) > 0)
    ? parseDockerCommand(resolved)
    : undefined;
};

const volumeCreateFailures = (
  args: readonly (string | undefined)[],
): string[] =>
  args.every((argument) => argument !== undefined) &&
  !isUnsafeVolumeCreate(volumeCreateOptions(args))
    ? []
    : ["Docker volume driver options cannot configure host binds"];

const volumeCreateArrayFailures = (
  array: ts.ArrayLiteralExpression,
  helpers: ReadonlySet<string>,
): string[] => {
  const failures: string[] = [];
  const command = arrayDockerCommand(array, helpers);
  if (command === "unresolved") {
    failures.push("Docker command options must be statically resolvable");
  } else if (command?.kind === "volume-create") {
    failures.push(...volumeCreateFailures(command.args));
  } else if (command?.kind === "run" && !hasResolvedRunOptions(command.args)) {
    failures.push(RUN_OPTIONS_MESSAGE);
  }
  if (!hasSafeVolumeDriverFlags(array.elements.map(staticArgument))) {
    failures.push("Only the local volume driver is allowed");
  }
  return failures;
};

const shellLineFailures = (line: string): string[] => {
  const failures: string[] = [];
  const dockerWord = /(?<![\w.-])docker(?=\s)/gu;
  for (
    let docker = dockerWord.exec(line);
    docker !== null;
    docker = dockerWord.exec(line)
  ) {
    const command = parseDockerCommand(
      shellWords(line.slice(docker.index + docker[0].length)),
    );
    if (command === "unresolved") {
      failures.push("Docker command options must be statically resolvable");
      continue;
    }
    if (command?.kind === "volume-create") {
      failures.push(...volumeCreateFailures(command.args));
    }
    if (command?.kind !== "run") {
      continue;
    }
    if (!hasResolvedRunOptions(command.args)) {
      failures.push(RUN_OPTIONS_MESSAGE);
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
  return failures;
};

// Default-deny: the HostConfig keys the repository uses. Anything else, such
// as VolumesFrom, Binds or Devices, can carry or inherit host mounts.
const allowedHostConfigKeys = new Set([
  "CapDrop",
  "ExtraHosts",
  "Memory",
  "Mounts",
  "NanoCpus",
  "NetworkMode",
  "PidsLimit",
  "ReadonlyRootfs",
  "SecurityOpt",
  "Tmpfs",
]);
const mountCarryingCreateKeys = new Set(["Volumes", "VolumesFrom", "Devices"]);

const hasOnlyKnownHostConfigKeys = (hostConfig: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(hostConfig) &&
  hostConfig.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      allowedHostConfigKeys.has(staticPropertyName(property.name) ?? ""),
  );

// Container create bodies (objects with an Image or HostConfig property).
const apiCreateConfigFailures = (node: ts.Node): string[] => {
  if (!ts.isObjectLiteralExpression(node)) {
    return [];
  }
  const named = node.properties.flatMap((property) =>
    ts.isPropertyAssignment(property) ? [property] : [],
  );
  const names = named.map(({ name }) => staticPropertyName(name));
  if (!names.includes("Image") && !names.includes("HostConfig")) {
    return [];
  }
  const failures: string[] = [];
  const hostConfig = named.find(
    ({ name }) => staticPropertyName(name) === "HostConfig",
  );
  if (hostConfig && !hasOnlyKnownHostConfigKeys(hostConfig.initializer)) {
    failures.push("Docker API HostConfig allows only known fields");
  }
  const unresolved = node.properties.some(
    (property) =>
      !ts.isPropertyAssignment(property) ||
      staticPropertyName(property.name) === undefined,
  );
  if (
    unresolved ||
    names.some((name) => mountCarryingCreateKeys.has(name ?? ""))
  ) {
    failures.push("Docker API container config cannot carry mounts");
  }
  return failures;
};

export const inspectDockerHelper = (source: string): string[] => {
  const failures: string[] = [];
  // Shell helpers are also discovered. Join continuations before checking
  // Docker command lines; TypeScript parsing alone does not see shell flags.
  const commands = source.replaceAll(/\\\r?\n/gu, " ");
  for (const line of commands.split("\n")) {
    failures.push(...shellLineFailures(line));
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
    failures.push(...apiCreateConfigFailures(node));
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
