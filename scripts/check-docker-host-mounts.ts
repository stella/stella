import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  type ArrayExpression,
  type ArrayExpressionElement,
  type CallExpression,
  isObjectLiteralProperty,
  type Node,
  type ObjectProperty,
  type ObjectPropertyKind,
  type Program,
  type TemplateLiteral,
  type TSTupleType,
  type TSType,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";

type Identifier = Extract<Node, { type: "Identifier" }>;

// The parsed helper: its validated-name helper imports and parent links
// (oxc nodes carry none).
type HelperTree = {
  helpers: ReadonlySet<string>;
  parents: ReadonlyMap<Node, Node>;
  sourceText: string;
};

// A string literal or a template without substitutions (TypeScript's
// StringLiteralLike), read as its cooked text.
const stringLiteralText = (
  node: Node | null | undefined,
): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

// A `key: value` object literal entry (TypeScript's PropertyAssignment).
const isPropertyAssignment = (
  property: ObjectPropertyKind,
): property is ObjectProperty =>
  property.type === "Property" &&
  !property.shorthand &&
  !property.method &&
  property.kind === "init";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const safeMountTypes = new Set(["volume", "tmpfs"]);
// Default-deny: local volume driver options outside this list can select a
// host path (type, o, device) or an unknown backend.
const safeDriverOptions = new Set(["size"]);
const isSafeDriverOptionKey = (key: string | undefined): boolean =>
  key !== undefined && safeDriverOptions.has(key.toLowerCase());

const staticPropertyName = (property: ObjectProperty): string | undefined => {
  const key = property.key;
  if (property.computed) {
    return stringLiteralText(key);
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "number") {
    return String(key.value);
  }
  return stringLiteralText(key);
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
    mount["type"] === "tmpfs" ||
    (mount["type"] === "volume" &&
      (mount["source"] === undefined ||
        (typeof mount["source"] === "string" &&
          volumeName.test(mount["source"]))))
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
const importedNameHelpers = (program: Program): ReadonlySet<string> => {
  const local = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        continue;
      }
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (NAME_HELPERS.has(imported)) {
        local.add(specifier.local.name);
      }
    }
  }
  return local;
};

// Cooked text of the template part after substitution `index`.
const templateTail = (template: TemplateLiteral, index: number): string =>
  template.quasis.at(index + 1)?.value.cooked ?? "";

// A mount string template is checkable only when every interpolation is a
// call to the imported helper; each is replaced by a placeholder volume name.
// Any other interpolation stays as raw `${` text, which inspectMountOptions
// rejects.
const mountTemplateText = (
  template: TemplateLiteral,
  tree: HelperTree,
): string => {
  const calls = template.expressions.every((expression) =>
    isVolumeNameHelperCall(expression, tree),
  );
  if (!calls) {
    return tree.sourceText.slice(template.start, template.end).slice(1, -1);
  }
  return (
    (template.quasis.at(0)?.value.cooked ?? "") +
    template.expressions
      .map((_, index) => `volume-name${templateTail(template, index)}`)
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

const hasSafeApiDriverConfig = (volumeOptions: Node): boolean => {
  if (volumeOptions.type !== "ObjectExpression") {
    return false;
  }
  return volumeOptions.properties.every((property) => {
    if (!isPropertyAssignment(property)) {
      return false;
    }
    if (staticPropertyName(property) !== "DriverConfig") {
      return staticPropertyName(property) !== undefined;
    }
    if (property.value.type !== "ObjectExpression") {
      return false;
    }
    const driverConfig = property.value;
    return driverConfig.properties.every((driverProperty) => {
      if (!isPropertyAssignment(driverProperty)) {
        return false;
      }
      const driverPropertyName = staticPropertyName(driverProperty);
      if (driverPropertyName === "Name") {
        const name = stringLiteralText(driverProperty.value);
        return name !== undefined && !isUnsafeDriverName(name);
      }
      if (driverPropertyName !== "Options") {
        return false;
      }
      return (
        driverProperty.value.type === "ObjectExpression" &&
        driverProperty.value.properties.every(
          (option) =>
            isPropertyAssignment(option) &&
            isSafeDriverOptionKey(staticPropertyName(option)),
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
        ((value["driver"] !== undefined && value["driver"] !== "local") ||
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
  const volumes = isRecord(document) ? document["volumes"] : undefined;
  if (isRecord(volumes)) {
    for (const [name, volume] of Object.entries(volumes)) {
      if (
        isRecord(volume) &&
        volume["driver"] !== undefined &&
        isUnsafeDriverName(volume["driver"])
      ) {
        failures.push(`compose.volumes.${name}: only the local volume driver`);
      }
    }
  }
  return failures;
};

const staticArgument = (
  element: ArrayExpressionElement | undefined,
): string | undefined => stringLiteralText(element);

const isVolumeNameHelperCall = (expression: Node, tree: HelperTree): boolean =>
  expression.type === "CallExpression" &&
  expression.callee.type === "Identifier" &&
  tree.helpers.has(expression.callee.name);

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
  element: ArrayExpressionElement,
  tree: HelperTree,
): string | undefined => {
  if (element === null) {
    return undefined;
  }
  if (
    element.type === "SpreadElement" &&
    isNonMountingCommandSpread(element.argument, tree)
  ) {
    return "non-mounting-command";
  }
  const literal = staticArgument(element);
  if (isVolumeNameHelperCall(element, tree)) {
    return "name";
  }
  if (literal !== undefined || element.type !== "TemplateLiteral") {
    return literal;
  }
  return element.expressions.every((expression) =>
    isVolumeNameHelperCall(expression, tree),
  )
    ? (element.quasis.at(0)?.value.cooked ?? "") +
        element.expressions
          .map((_, index) => `volume${templateTail(element, index)}`)
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
    if (width === 0 || (width === 2 && index + 1 >= args.length)) {
      return "unresolved";
    }
    index += width - 1;
  }
  const rest = args.slice(index + 1);
  const subcommand = args[index];
  if (subcommand === undefined) {
    return undefined;
  }
  switch (subcommand) {
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

type NonMountingTypeOptions = {
  type: TSType;
  tree: HelperTree;
  seen?: Set<TSType>;
};

// The declaration in `statement` that binds the type `name`, if any.
const commandTypeOwner = (statement: Node, name: string): Node | undefined => {
  let declaration = statement;
  if (statement.type === "ExportDefaultDeclaration") {
    declaration = statement.declaration;
  } else if (
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration !== null
  ) {
    declaration = statement.declaration;
  }
  if (
    declaration.type === "TSTypeAliasDeclaration" ||
    declaration.type === "TSInterfaceDeclaration" ||
    declaration.type === "TSEnumDeclaration" ||
    declaration.type === "TSImportEqualsDeclaration"
  ) {
    return declaration.id.name === name ? declaration : undefined;
  }
  if (declaration.type === "ClassDeclaration") {
    return declaration.id?.name === name ? declaration : undefined;
  }
  if (declaration.type === "ImportDeclaration") {
    return declaration.specifiers.some(
      (specifier) => specifier.local.name === name,
    )
      ? declaration
      : undefined;
  }
  return undefined;
};

const isNonMountingTuple = (type: TSTupleType): boolean => {
  const prefix: string[] = [];
  for (const element of type.elementTypes) {
    if (
      element.type !== "TSLiteralType" ||
      element.literal.type !== "Literal" ||
      typeof element.literal.value !== "string"
    ) {
      break;
    }
    prefix.push(element.literal.value);
  }
  if (
    prefix.length === 0 ||
    ((prefix.at(0) === "volume" || prefix.at(0) === "container") &&
      prefix.length < 2)
  ) {
    return false;
  }
  return parseDockerCommand(prefix) === undefined;
};

// Declarations whose type parameters shadow an outer type name (TypeScript's
// function-like nodes, classes, interfaces and type aliases).
const TYPE_PARAMETER_SCOPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSInterfaceDeclaration",
  "TSMethodSignature",
  "TSTypeAliasDeclaration",
]);

const declaresTypeParameter = (scope: Node, name: string): boolean =>
  TYPE_PARAMETER_SCOPES.has(scope.type) &&
  "typeParameters" in scope &&
  (scope.typeParameters?.params.some(
    (parameter) => parameter.name.name === name,
  ) ??
    false);

const isNonMountingCommandType = ({
  type,
  tree,
  seen = new Set<TSType>(),
}: NonMountingTypeOptions): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  if (type.type === "TSTypeOperator" && type.operator === "readonly") {
    return isNonMountingCommandType({ type: type.typeAnnotation, tree, seen });
  }
  if (type.type === "TSUnionType") {
    return type.types.every((branch) =>
      isNonMountingCommandType({ type: branch, tree, seen: new Set(seen) }),
    );
  }
  if (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    !type.typeArguments?.params.length
  ) {
    const name = type.typeName.name;
    for (
      let scope = tree.parents.get(type);
      scope !== undefined;
      scope = tree.parents.get(scope)
    ) {
      if (declaresTypeParameter(scope, name)) {
        return false;
      }
      if (scope.type !== "BlockStatement" && scope.type !== "Program") {
        continue;
      }
      let alias: Node | undefined;
      for (const statement of scope.body) {
        alias ??= commandTypeOwner(statement, name);
      }
      if (alias !== undefined) {
        return (
          alias.type === "TSTypeAliasDeclaration" &&
          !alias.typeParameters?.params.length &&
          isNonMountingCommandType({ type: alias.typeAnnotation, tree, seen })
        );
      }
    }
    return false;
  }
  if (type.type !== "TSTupleType") {
    return false;
  }
  return isNonMountingTuple(type);
};

const bindingNamesCommand = (binding: Node, name: string): boolean => {
  if (binding.type === "Identifier") {
    return binding.name === name;
  }
  // A default value or rest marker wraps the bound name.
  if (binding.type === "AssignmentPattern") {
    return bindingNamesCommand(binding.left, name);
  }
  if (binding.type === "RestElement") {
    return bindingNamesCommand(binding.argument, name);
  }
  if (binding.type === "TSParameterProperty") {
    return bindingNamesCommand(binding.parameter, name);
  }
  if (binding.type === "ObjectPattern") {
    return binding.properties.some((property) =>
      bindingNamesCommand(
        property.type === "RestElement" ? property : property.value,
        name,
      ),
    );
  }
  if (binding.type === "ArrayPattern") {
    return binding.elements.some(
      (element) => element !== null && bindingNamesCommand(element, name),
    );
  }
  return false;
};

// A parameter bound to a plain name, and its declared type.
const namedParameterType = (
  parameter: Node,
): { named: boolean; type: TSType | undefined } => {
  if (parameter.type === "Identifier") {
    return {
      named: true,
      type: parameter.typeAnnotation?.typeAnnotation,
    };
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.left.type === "Identifier"
      ? {
          named: true,
          type: parameter.left.typeAnnotation?.typeAnnotation,
        }
      : { named: false, type: undefined };
  }
  if (parameter.type === "RestElement") {
    return {
      named: parameter.argument.type === "Identifier",
      type: parameter.typeAnnotation?.typeAnnotation,
    };
  }
  if (parameter.type === "TSParameterProperty") {
    return namedParameterType(parameter.parameter);
  }
  return { named: false, type: undefined };
};

type BlockCommandDomainOptions = {
  statements: readonly Node[];
  reference: Identifier;
  seen: Set<Node>;
  tree: HelperTree;
};

const blockCommandDomain = ({
  statements,
  reference,
  seen,
  tree,
}: BlockCommandDomainOptions): boolean | undefined => {
  for (const entry of statements) {
    let statement = entry;
    if (entry.type === "ExportDefaultDeclaration") {
      statement = entry.declaration;
    } else if (
      entry.type === "ExportNamedDeclaration" &&
      entry.declaration !== null
    ) {
      statement = entry.declaration;
    }
    if (statement.type !== "VariableDeclaration") {
      if (
        (statement.type === "FunctionDeclaration" ||
          statement.type === "TSDeclareFunction" ||
          statement.type === "ClassDeclaration") &&
        statement.id?.name === reference.name
      ) {
        return false;
      }
      continue;
    }
    const declaration = statement.declarations.find(({ id }) =>
      bindingNamesCommand(id, reference.name),
    );
    if (declaration === undefined) {
      continue;
    }
    if (declaration.id.type !== "Identifier") {
      return false;
    }
    const type = declaration.id.typeAnnotation?.typeAnnotation;
    if (type !== undefined) {
      return isNonMountingCommandType({ type, tree });
    }
    return (
      statement.kind === "const" &&
      declaration.init !== null &&
      isNonMountingCommandSpread(declaration.init, tree, seen)
    );
  }
  return undefined;
};

const isNonMountingCommandSpread = (
  expression: Node,
  tree: HelperTree,
  seen = new Set<Node>(),
): boolean => {
  if (expression.type !== "Identifier" || seen.has(expression)) {
    return false;
  }
  seen.add(expression);
  const name = expression.name;
  for (
    let node = tree.parents.get(expression);
    node !== undefined;
    node = tree.parents.get(node)
  ) {
    if (node.type === "BlockStatement" || node.type === "Program") {
      const proof = blockCommandDomain({
        statements: node.body,
        reference: expression,
        seen,
        tree,
      });
      if (proof !== undefined) {
        return proof;
      }
    }
    if (node.type === "Program") {
      return false;
    }
    if (
      node.type === "CatchClause" &&
      node.param !== null &&
      bindingNamesCommand(node.param, name)
    ) {
      return false;
    }
    let loopDeclaration: Node | null = null;
    if (node.type === "ForStatement") {
      loopDeclaration = node.init;
    } else if (
      node.type === "ForOfStatement" ||
      node.type === "ForInStatement"
    ) {
      loopDeclaration = node.left;
    }
    if (
      loopDeclaration?.type === "VariableDeclaration" &&
      loopDeclaration.declarations.some(({ id }) =>
        bindingNamesCommand(id, name),
      )
    ) {
      return false;
    }
    if (
      node.type !== "ArrowFunctionExpression" &&
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression"
    ) {
      continue;
    }
    if (node.type === "FunctionExpression" && node.id?.name === name) {
      return false;
    }
    const parameter = node.params.find((entry) =>
      bindingNamesCommand(entry, name),
    );
    if (parameter !== undefined) {
      const { named, type } = namedParameterType(parameter);
      return (
        named && type !== undefined && isNonMountingCommandType({ type, tree })
      );
    }
  }
  return false;
};

const dockerSubcommands = new Set(["run", "create", "volume", "container"]);

// ["docker", ...globals, "volume", "create", ...] or, when the command is a
// separate spawn argument, an array that starts at the globals or subcommand.
const arrayDockerCommand = (
  array: ArrayExpression,
  tree: HelperTree,
): DockerCommand => {
  const resolved = array.elements.map((element) =>
    resolvedRunArgument(element, tree),
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
  array: ArrayExpression,
  tree: HelperTree,
): string[] => {
  const failures: string[] = [];
  const command = arrayDockerCommand(array, tree);
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

const hasOnlyKnownHostConfigKeys = (hostConfig: Node): boolean =>
  hostConfig.type === "ObjectExpression" &&
  hostConfig.properties.every(
    (property) =>
      isPropertyAssignment(property) &&
      allowedHostConfigKeys.has(staticPropertyName(property) ?? ""),
  );

// Container create bodies (objects with an Image or HostConfig property).
const apiCreateConfigFailures = (node: Node): string[] => {
  if (node.type !== "ObjectExpression") {
    return [];
  }
  const named = node.properties.filter(isPropertyAssignment);
  const names = named.map(staticPropertyName);
  if (!names.includes("Image") && !names.includes("HostConfig")) {
    return [];
  }
  const failures: string[] = [];
  const hostConfig = named.find(
    (property) => staticPropertyName(property) === "HostConfig",
  );
  if (hostConfig && !hasOnlyKnownHostConfigKeys(hostConfig.value)) {
    failures.push("Docker API HostConfig allows only known fields");
  }
  const unresolved = node.properties.some(
    (property) =>
      !isPropertyAssignment(property) ||
      staticPropertyName(property) === undefined,
  );
  if (
    unresolved ||
    names.some((name) => mountCarryingCreateKeys.has(name ?? ""))
  ) {
    failures.push("Docker API container config cannot carry mounts");
  }
  return failures;
};

const calleeName = (call: CallExpression): string | undefined => {
  if (call.callee.type === "Identifier") {
    return call.callee.name;
  }
  return call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.property.type === "Identifier"
    ? call.callee.property.name
    : undefined;
};

const hasSafeApiVolumeCreateBody = (body: Node): boolean =>
  body.type === "ObjectExpression" &&
  body.properties.every((property) => {
    if (!isPropertyAssignment(property)) {
      return false;
    }
    const name = staticPropertyName(property);
    if (name === "Driver") {
      const driver = stringLiteralText(property.value);
      return driver !== undefined && !isUnsafeDriverName(driver);
    }
    if (name === "DriverOpts") {
      return (
        property.value.type === "ObjectExpression" &&
        property.value.properties.every(
          (option) =>
            isPropertyAssignment(option) &&
            isSafeDriverOptionKey(staticPropertyName(option)),
        )
      );
    }
    return name !== undefined;
  });

// Docker API volume creation: createVolume(...) bodies and any object with
// Driver/DriverOpts next to a Name. Same driver predicates as every other path.
const apiVolumeCreateFailures = (node: Node): string[] => {
  const failures: string[] = [];
  if (node.type === "CallExpression" && calleeName(node) === "createVolume") {
    const body = node.arguments.at(-1);
    if (!body || !hasSafeApiVolumeCreateBody(body)) {
      failures.push("Docker API volume creation allows only the local driver");
    }
  }
  if (node.type === "ObjectExpression") {
    const names = node.properties.map((property) =>
      isPropertyAssignment(property) ? staticPropertyName(property) : undefined,
    );
    if (
      (names.includes("DriverOpts") ||
        (names.includes("Driver") && names.includes("Name"))) &&
      !hasSafeApiVolumeCreateBody(node)
    ) {
      failures.push("Docker API volume creation allows only the local driver");
    }
  }
  return failures;
};

// A string a helper spells out: any mount it names must be explicit.
const literalFailures = (value: string): string[] => {
  const failures: string[] = [];
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
    value.startsWith("-v") ||
    /^(?:--volume)(?:=|$)/u.test(value) ||
    /(?:^|[\s"'`])(?:-v[^\s]*|--volume(?:\s|=))/u.test(value)
  ) {
    failures.push(
      "Use explicit --mount type=volume instead of ambiguous -v/--volume",
    );
  }
  return failures;
};

// A quoted string on one line, by its opening quote.
const QUOTED_TEXT = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/gu;

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
  const parsed = parseSync("helper.ts", source);
  if (
    parsed.errors.some((error) => {
      // oxc-parser declares Severity as an ambient const enum of strings.
      const severity: string = error.severity;
      return severity === "Error";
    })
  ) {
    // Shell and Python helpers are not TypeScript: their command lines are
    // checked as text above, and their quoted strings are read as the
    // literals they would be in a script.
    for (const match of source.matchAll(QUOTED_TEXT)) {
      failures.push(...literalFailures(match[2] ?? ""));
    }
    return failures;
  }
  const { program } = parsed;
  const parents = new Map<Node, Node>();
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  const tree: HelperTree = {
    helpers: importedNameHelpers(program),
    parents,
    sourceText: source,
  };
  walk(program, (node) => {
    const value =
      node.type === "TemplateLiteral" && node.expressions.length > 0
        ? source.slice(node.start, node.end)
        : stringLiteralText(node);
    if (value !== undefined) {
      failures.push(...literalFailures(value));
    }
    const parent = parents.get(node);
    const property =
      isObjectLiteralProperty(node, parent) && isPropertyAssignment(node)
        ? node
        : undefined;
    if (
      property !== undefined &&
      staticPropertyName(property)?.toLowerCase() === "type" &&
      stringLiteralText(property.value)?.toLowerCase() === "bind"
    ) {
      failures.push("Docker API bind Mounts are forbidden");
    }
    if (property !== undefined && staticPropertyName(property) === "Mounts") {
      const mounts = property.value;
      const safe =
        mounts.type === "ArrayExpression" &&
        mounts.elements.every(
          (mount) =>
            mount?.type === "ObjectExpression" &&
            mount.properties.every((entry) => {
              if (!isPropertyAssignment(entry)) {
                return false;
              }
              const name = staticPropertyName(entry);
              if (name === undefined) {
                return false;
              }
              if (name === "Type") {
                return safeMountTypes.has(stringLiteralText(entry.value) ?? "");
              }
              if (name === "VolumeOptions") {
                return hasSafeApiDriverConfig(entry.value);
              }
              return true;
            }) &&
            mount.properties.some(
              (entry) =>
                isPropertyAssignment(entry) &&
                staticPropertyName(entry) === "Type" &&
                safeMountTypes.has(stringLiteralText(entry.value) ?? ""),
            ),
        );
      if (!safe) {
        failures.push(
          "Docker API Mounts require explicit volume or tmpfs types",
        );
      }
    }
    failures.push(
      ...apiCreateConfigFailures(node),
      ...apiVolumeCreateFailures(node),
    );
    if (node.type === "ArrayExpression") {
      failures.push(...volumeCreateArrayFailures(node, tree));
      for (const [index, element] of node.elements.entries()) {
        if (stringLiteralText(element) !== "--mount") {
          continue;
        }
        const argument = node.elements[index + 1];
        let mount = stringLiteralText(argument);
        if (argument?.type === "TemplateLiteral" && mount === undefined) {
          mount = mountTemplateText(argument, tree);
        }
        if (!mount || !inspectMountOptions(mount)) {
          failures.push("--mount requires explicit type=volume or type=tmpfs");
        }
      }
    }
  });
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
