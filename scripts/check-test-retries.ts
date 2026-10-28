/** Prevent automated retries from hiding flaky test behavior. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseSync } from "oxc-parser";

import {
  type ArrayExpression,
  type CallExpression,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLAYWRIGHT_CONFIG = /(?:^|\/)playwright[^/]*\.config\.(?:[cm]?[jt]s)$/u;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const PACKAGE_FILE = /(?:^|\/)package\.json$/u;
const WORKFLOW_FILE = /^\.github\/(?:workflows|actions)\/.*\.ya?ml$/u;
const PROCESS_CALL_NAMES = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
]);
const TEST_COMMAND =
  /(?:\bbun\b[^;&|\n]*\s(?:test|test:[\w-]+)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?\b|\bdeno\s+test\b|\bturbo\s+run\s+test(?::[\w-]+)?\b|\bplaywright\s+test\b|\b(?:vitest|jest)\b|\brun-tests\.ts\b|\btest-path-filters\.ts\b)/iu;
const RETRY_FLAG =
  /(?:^|\s)--(?:retry|retries|retry-times|rerun-each)(?=$|[\s=])/iu;

export type TestRetryFinding = {
  file: string;
  message: string;
};

type SourceMap = ReadonlyMap<string, string>;

type Source = { file: string; program: Program; text: string };

type Wrapper =
  "ParenthesizedExpression" | "TSAsExpression" | "TSSatisfiesExpression";

const isPlaywrightConfig = (file: string): boolean =>
  PLAYWRIGHT_CONFIG.test(file);

const isSourceFile = (file: string): boolean => SOURCE_FILE.test(file);

const hasRetryRelevantSyntax = (source: string): boolean =>
  /\b(?:Bun\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync)\s*\(|(?:describe|test\.describe)\.configure\s*\(/u.test(
    source,
  );

const unwrap = (node: Node, wrappers: readonly Wrapper[]): Node => {
  let value = node;
  while (
    (value.type === "ParenthesizedExpression" ||
      value.type === "TSAsExpression" ||
      value.type === "TSSatisfiesExpression") &&
    wrappers.includes(value.type)
  ) {
    value = value.expression;
  }
  return value;
};

// Numbers read as their value's text, like TypeScript's literal text.
const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal") {
    if (typeof node.value === "string") {
      return node.value;
    }
    if (typeof node.value === "number") {
      return String(node.value);
    }
  }
  return undefined;
};

const propertyName = (property: ObjectProperty): string | undefined => {
  const key = property.key;
  if (property.computed) {
    if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
      return key.quasis.at(0)?.value.cooked ?? undefined;
    }
    return literalText(key);
  }
  return key.type === "Identifier" ? key.name : literalText(key);
};

// A `key: value` entry: neither shorthand nor a method or accessor.
const isPropertyAssignment = (property: ObjectProperty): boolean =>
  !property.shorthand && !property.method && property.kind === "init";

const isObjectExpression = (node: Node): node is ObjectExpression =>
  node.type === "ObjectExpression";

const configObject = (statement: Node): ObjectExpression | undefined => {
  let expression: Node;
  if (statement.type === "ExportDefaultDeclaration") {
    expression = statement.declaration;
  } else if (statement.type === "TSExportAssignment") {
    expression = statement.expression;
  } else {
    return undefined;
  }
  expression = unwrap(expression, ["TSAsExpression", "TSSatisfiesExpression"]);
  const call =
    expression.type === "ChainExpression" ? expression.expression : expression;
  if (call.type === "CallExpression") {
    return call.arguments.toReversed().find(isObjectExpression);
  }
  return isObjectExpression(expression) ? expression : undefined;
};

// Resolve imported device presets from the pinned package's literal data,
// rather than exempting spreads by identifier or trusting arbitrary imports.
const resolveDevicePreset = (
  expression: Node,
  source: Source,
): ObjectExpression | undefined => {
  const access =
    expression.type === "ChainExpression" ? expression.expression : expression;
  if (
    access.type !== "MemberExpression" ||
    !access.computed ||
    access.object.type !== "Identifier" ||
    access.property.type !== "Literal" ||
    typeof access.property.value !== "string"
  ) {
    return undefined;
  }
  const binding = access.object.name;
  const presetName = access.property.value;
  const imported = source.program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === "@playwright/test" &&
      statement.specifiers.some(
        (entry) =>
          entry.type === "ImportSpecifier" &&
          entry.local.name === binding &&
          (entry.imported.type === "Identifier"
            ? entry.imported.name
            : entry.imported.value) === "devices",
      ),
  );
  if (!imported) {
    return undefined;
  }
  // Dependency resolution and descriptor reads are filesystem boundaries.
  try {
    const requireConfig = createRequire(path.resolve(REPO_ROOT, source.file));
    const testEntry = requireConfig.resolve("@playwright/test");
    const playwrightEntry = createRequire(testEntry).resolve("playwright");
    const coreEntry = createRequire(playwrightEntry).resolve("playwright-core");
    const descriptors: unknown = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(coreEntry),
          "lib/server/deviceDescriptorsSource.json",
        ),
        "utf-8",
      ),
    );
    if (!isRecord(descriptors)) {
      return undefined;
    }
    const descriptor = descriptors[presetName];
    if (!isRecord(descriptor)) {
      return undefined;
    }
    const literal = parseSource(
      "device-preset.ts",
      `export default ${JSON.stringify(descriptor)};`,
    );
    const statement = literal.program.body.at(0);
    return statement === undefined ? undefined : configObject(statement);
  } catch {
    return undefined;
  }
};

const resolveVariable = (name: string, source: Source): Node | undefined => {
  for (const statement of source.program.body) {
    let declaration: Node = statement;
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null
    ) {
      declaration = statement.declaration;
    }
    if (declaration.type !== "VariableDeclaration") {
      continue;
    }
    const declarator = declaration.declarations.find(
      (entry) => entry.id.type === "Identifier" && entry.id.name === name,
    );
    if (declarator !== undefined && declarator.init !== null) {
      return declarator.init;
    }
  }
  return undefined;
};

const resolveObject = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): ObjectExpression | undefined => {
  const value = unwrap(expression, [
    "TSAsExpression",
    "TSSatisfiesExpression",
    "ParenthesizedExpression",
  ]);
  if (value.type === "ObjectExpression") {
    return value;
  }
  const device = resolveDevicePreset(value, source);
  if (device !== undefined) {
    return device;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : resolveObject(initializer, source, visited);
};

const numericValue = (expression: Node): number | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
  ]);
  return value.type === "Literal" && typeof value.value === "number"
    ? value.value
    : undefined;
};

const resolveArray = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): ArrayExpression | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "ArrayExpression") {
    return value;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : resolveArray(initializer, source, visited);
};

const literalCommandPart = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): string | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "TemplateLiteral") {
    return value.expressions.length === 0
      ? (value.quasis.at(0)?.value.cooked ?? undefined)
      : source.text.slice(value.start, value.end);
  }
  const text = literalText(value);
  if (text !== undefined) {
    return text;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : literalCommandPart(initializer, source, visited);
};

const commandArray = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): string[] | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "Identifier") {
    if (visited.has(value.name)) {
      return undefined;
    }
    visited.add(value.name);
    const initializer = resolveVariable(value.name, source);
    return initializer === undefined
      ? undefined
      : commandArray(initializer, source, visited);
  }
  if (value.type !== "ArrayExpression") {
    return undefined;
  }
  const parts: string[] = [];
  for (const element of value.elements) {
    if (element === null) {
      continue;
    }
    if (element.type === "SpreadElement") {
      const spread = commandArray(element.argument, source, visited);
      if (spread !== undefined) {
        parts.push(...spread);
      }
      continue;
    }
    const part = literalCommandPart(element, source);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts;
};

const processCommand = (
  call: CallExpression,
  source: Source,
): string | undefined => {
  const callee = call.callee;
  let name: string | undefined;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    name = callee.property.name;
  } else if (callee.type === "Identifier") {
    name = callee.name;
  }
  if (name === undefined || !PROCESS_CALL_NAMES.has(name)) {
    return undefined;
  }
  const [first, second] = call.arguments;
  if (first === undefined) {
    return undefined;
  }
  if (first.type === "ObjectExpression") {
    const command = first.properties.find(
      (member): member is ObjectProperty =>
        member.type === "Property" &&
        isPropertyAssignment(member) &&
        propertyName(member) === "cmd",
    );
    if (command !== undefined) {
      const parts = commandArray(command.value, source);
      if (parts !== undefined) {
        return parts.join(" ");
      }
      return literalCommandPart(command.value, source);
    }
  }
  const firstParts = commandArray(first, source);
  if (firstParts !== undefined) {
    return firstParts.join(" ");
  }
  const executable = literalCommandPart(first, source);
  if (executable === undefined) {
    return undefined;
  }
  const secondParts =
    second === undefined ? undefined : commandArray(second, source);
  return [executable, ...(secondParts ?? [])].join(" ");
};

const effectiveRetries = (
  object: ObjectExpression,
  source: Source,
): {
  explicit: boolean;
  value: number | undefined;
  unknownOverride: boolean;
} => {
  let explicit = false;
  let value: number | undefined;
  let unknownOverride = false;
  for (const member of object.properties) {
    if (member.type === "SpreadElement") {
      const spreadObject = resolveObject(member.argument, source);
      if (spreadObject === undefined) {
        unknownOverride = true;
        continue;
      }
      const spread = effectiveRetries(spreadObject, source);
      if (spread.value !== undefined || spread.unknownOverride) {
        value = spread.value;
        unknownOverride = spread.unknownOverride;
      }
      continue;
    }
    // Shorthand values are not literal retry policies; reject them even when
    // a same-named binding happens to be zero today.
    if (member.shorthand && propertyName(member) === "retries") {
      explicit = true;
      value = undefined;
      unknownOverride = false;
      continue;
    }
    if (!isPropertyAssignment(member) || propertyName(member) !== "retries") {
      if (
        isPropertyAssignment(member) &&
        propertyName(member) === undefined &&
        (explicit || value !== undefined)
      ) {
        unknownOverride = true;
      }
      continue;
    }
    explicit = true;
    value = numericValue(member.value);
    unknownOverride = false;
  }
  return { explicit, value, unknownOverride };
};

const hasRetryViolation = (
  retries: ReturnType<typeof effectiveRetries>,
): boolean =>
  (retries.unknownOverride &&
    (retries.explicit || retries.value !== undefined)) ||
  (retries.explicit && retries.value !== 0) ||
  (retries.value !== undefined && retries.value !== 0);

const nestedObjectLiterals = (
  expression: ObjectExpression,
  source: Source,
): { objects: ObjectExpression[]; unknownConfig: boolean } => {
  const objects: ObjectExpression[] = [];
  const active = new Set<Node>();
  let unknownConfig = false;
  const visitExpression = (
    value: Node,
    failClosed = false,
    collect = true,
    projectElements = false,
  ): void => {
    const resolved =
      resolveArray(value, source) ?? resolveObject(value, source);
    if (resolved !== undefined) {
      visit(resolved, collect, projectElements);
      return;
    }
    if (failClosed) {
      unknownConfig = true;
    }
  };
  const visit = (
    node: ObjectExpression | ArrayExpression,
    collect = true,
    projectElements = false,
  ): void => {
    if (active.has(node)) {
      unknownConfig = true;
      return;
    }
    active.add(node);
    if (node.type === "ObjectExpression") {
      if (collect) {
        objects.push(node);
      }
      for (const member of node.properties) {
        if (member.type === "SpreadElement") {
          // The containing object's effectiveRetries already evaluates this
          // spread in order; inspect its children without judging overridden values.
          visitExpression(member.argument, true, false);
          continue;
        }
        let name: string | undefined;
        if (member.shorthand || isPropertyAssignment(member)) {
          name = propertyName(member);
        } else {
          continue;
        }
        visitExpression(
          member.value,
          name === "projects" || name === "use",
          true,
          name === "projects",
        );
      }
    } else {
      for (const element of node.elements) {
        if (element === null) {
          // A hole is an element no reader can resolve.
          if (projectElements) {
            unknownConfig = true;
          }
        } else if (element.type === "SpreadElement") {
          visitExpression(element.argument, true, true, projectElements);
        } else {
          visitExpression(element, projectElements, true, projectElements);
        }
      }
    }
    active.delete(node);
  };
  visit(expression);
  return { objects, unknownConfig };
};

const scanConfig = (file: string, sourceText: string): TestRetryFinding[] => {
  // Syntax errors are a finding here, so read them as data.
  const parsed = parseSync(file, sourceText);
  if (
    parsed.errors.some((error) => {
      // oxc-parser declares Severity as an ambient const enum of strings.
      const severity: string = error.severity;
      return severity === "Error";
    })
  ) {
    return [{ file, message: "Playwright config has TypeScript parse errors" }];
  }
  const source: Source = { file, program: parsed.program, text: sourceText };
  const object = source.program.body.map(configObject).find(Boolean);
  if (object === undefined) {
    return [
      {
        file,
        message: "Playwright config must explicitly set top-level retries: 0",
      },
    ];
  }
  const retries = effectiveRetries(object, source);
  const findings: TestRetryFinding[] = [];
  if (!retries.explicit || retries.value !== 0 || retries.unknownOverride) {
    findings.push({
      file,
      message:
        "Playwright config must explicitly set top-level retries: 0 as its effective value",
    });
  }
  const nested = nestedObjectLiterals(object, source);
  if (nested.unknownConfig) {
    findings.push({
      file,
      message:
        "Playwright project/use configuration is not statically inspectable",
    });
  }
  for (const nestedObject of nested.objects.slice(1)) {
    if (hasRetryViolation(effectiveRetries(nestedObject, source))) {
      findings.push({
        file,
        message: "Playwright project/use retries must be statically set to 0",
      });
    }
  }
  return findings;
};

const scanTestSource = (
  file: string,
  sourceText: string,
): TestRetryFinding[] => {
  const source: Source = {
    file,
    program: parseSource(file, sourceText).program,
    text: sourceText,
  };
  const findings: TestRetryFinding[] = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const command = processCommand(node, source);
    if (command !== undefined) {
      findings.push(...scanCommand(file, command, "TS/JS process invocation"));
    }
    const callee = node.callee;
    const isConfigure =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "configure" &&
      ["describe", "test.describe"].includes(
        sourceText.slice(callee.object.start, callee.object.end),
      );
    if (isConfigure) {
      const [options] = node.arguments;
      const resolvedOptions =
        options === undefined ? undefined : resolveObject(options, source);
      if (
        resolvedOptions === undefined ||
        hasRetryViolation(effectiveRetries(resolvedOptions, source))
      ) {
        findings.push({
          file,
          message:
            "test.describe.configure has dynamic or nonzero retry settings",
        });
      }
    }
  });
  return findings;
};

const hasTestCommand = (command: string): boolean => TEST_COMMAND.test(command);

const scanCommand = (
  file: string,
  command: string,
  context: string,
): TestRetryFinding[] => {
  const findings: TestRetryFinding[] = [];
  const commands = command.replace(/\\\r?\n/gu, " ").split(/&&|\|\||;|\r?\n/u);
  for (const segment of commands) {
    if (!hasTestCommand(segment)) {
      continue;
    }
    if (RETRY_FLAG.test(segment.replace(/["']/gu, ""))) {
      findings.push({
        file,
        message: `${context} passes a test retry option`,
      });
    }
    if (
      /\b(?:bash\s+)?(?:\.\/)?(?:\.workflow-source\/|\.workflow-tooling\/)?scripts\/retry\.sh\b/iu.test(
        segment,
      )
    ) {
      findings.push({
        file,
        message: `${context} wraps a test command in scripts/retry.sh`,
      });
    }
  }
  return findings;
};

const scanPackage = (file: string, sourceText: string): TestRetryFinding[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return [{ file, message: "package.json is not valid JSON" }];
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return [];
  }
  const scripts = parsed.scripts;
  if (scripts === undefined) {
    return [];
  }
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    return [{ file, message: "package.json scripts must be an object" }];
  }
  return Object.entries(scripts).flatMap(([name, command]) => {
    if (typeof command !== "string") {
      return [];
    }
    return scanCommand(file, command, `package script ${name}`);
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scanWorkflow = (file: string, sourceText: string): TestRetryFinding[] => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(sourceText);
  } catch {
    return [{ file, message: "workflow/action YAML is invalid" }];
  }
  if (!isRecord(parsed)) {
    return [{ file, message: "workflow/action YAML must have a mapping root" }];
  }
  if (
    (file.startsWith(".github/workflows/") && !isRecord(parsed["jobs"])) ||
    (file.startsWith(".github/actions/") && !isRecord(parsed["runs"]))
  ) {
    return [
      {
        file,
        message: "workflow/action YAML is missing its jobs/runs mapping",
      },
    ];
  }
  const findings: TestRetryFinding[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const inputs: string[] = [];
    for (const key of ["run", "command", "script"]) {
      const input = value[key];
      if (typeof input === "string") {
        inputs.push(input);
      }
    }
    const withInputs = value["with"];
    const actionInputs: string[] = [...inputs];
    if (isRecord(withInputs)) {
      for (const key of ["command", "script"]) {
        const input = withInputs[key];
        if (typeof input === "string") {
          actionInputs.push(input);
        }
      }
    }
    const commands = inputs.join("\n");
    findings.push(...scanCommand(file, commands, "workflow/action step"));
    const uses = value["uses"];
    if (
      typeof uses === "string" &&
      /(?:^|\/)[^/]*retry[^/]*(?:@|$)/iu.test(uses) &&
      hasTestCommand(actionInputs.join("\n"))
    ) {
      findings.push({
        file,
        message: "workflow/action retry step wraps a test command",
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "with") {
        visit(child);
      }
    }
    visit(withInputs);
  };
  visit(parsed);
  return findings;
};

export const findTestRetryViolations = (
  sources: SourceMap,
): TestRetryFinding[] => {
  const findings: TestRetryFinding[] = [];
  for (const [file, source] of sources) {
    if (isPlaywrightConfig(file)) {
      findings.push(...scanConfig(file, source));
    }
    if (isSourceFile(file) && hasRetryRelevantSyntax(source)) {
      findings.push(...scanTestSource(file, source));
    }
    if (file.endsWith(".sh")) {
      const commands = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      findings.push(...scanCommand(file, commands, "shell launcher"));
    }
    if (PACKAGE_FILE.test(file)) {
      findings.push(...scanPackage(file, source));
    }
    if (WORKFLOW_FILE.test(file)) {
      findings.push(...scanWorkflow(file, source));
    }
  }
  return findings;
};

const trackedSources = (): Map<string, string> => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    maxBuffer: 2 ** 30,
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(
      (file) =>
        isPlaywrightConfig(file) ||
        isSourceFile(file) ||
        file.endsWith(".sh") ||
        PACKAGE_FILE.test(file) ||
        WORKFLOW_FILE.test(file),
    );
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    if (isSourceFile(file) && !hasRetryRelevantSyntax(source)) {
      continue;
    }
    sources.set(file, source);
  }
  return sources;
};

export const checkTestRetries = (): TestRetryFinding[] =>
  findTestRetryViolations(trackedSources());

if (import.meta.main) {
  const findings = checkTestRetries();
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.file}: ${finding.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("Test retry guard passed.\n");
  }
}
