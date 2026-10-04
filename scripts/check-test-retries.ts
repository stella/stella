/** Prevent automated retries from hiding flaky test behavior. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

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

const isPlaywrightConfig = (file: string): boolean =>
  PLAYWRIGHT_CONFIG.test(file);

const isSourceFile = (file: string): boolean => SOURCE_FILE.test(file);

const hasRetryRelevantSyntax = (source: string): boolean =>
  /\b(?:Bun\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync)\s*\(|(?:describe|test\.describe)\.configure\s*\(/u.test(
    source,
  );

const isTsxOrJsx = (file: string): boolean =>
  file.endsWith(".tsx") || file.endsWith(".jsx");

const parseSource = (file: string, source: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    isTsxOrJsx(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const propertyName = (
  name: ts.PropertyName | undefined,
): string | undefined => {
  if (name === undefined) {
    return undefined;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
};

const configObject = (
  statement: ts.Statement,
): ts.ObjectLiteralExpression | undefined => {
  if (!ts.isExportAssignment(statement)) {
    return undefined;
  }
  let expression = statement.expression;
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (ts.isCallExpression(expression)) {
    return expression.arguments.toReversed().find(ts.isObjectLiteralExpression);
  }
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
};

// Resolve imported device presets from the pinned package's literal data,
// rather than exempting spreads by identifier or trusting arbitrary imports.
const resolveDevicePreset = (
  expression: ts.Expression,
  source: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined => {
  if (
    !ts.isElementAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !ts.isStringLiteral(expression.argumentExpression)
  ) {
    return undefined;
  }
  const binding = expression.expression.text;
  const imported = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@playwright/test" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (entry) =>
          entry.name.text === binding &&
          (entry.propertyName?.text ?? entry.name.text) === "devices",
      ),
  );
  if (!imported) {
    return undefined;
  }
  // Dependency resolution and descriptor reads are filesystem boundaries.
  try {
    const requireConfig = createRequire(
      path.resolve(REPO_ROOT, source.fileName),
    );
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
    const descriptor = descriptors[expression.argumentExpression.text];
    if (!isRecord(descriptor)) {
      return undefined;
    }
    const literal = parseSource(
      "device-preset.ts",
      `export default ${JSON.stringify(descriptor)};`,
    );
    const statement = literal.statements.at(0);
    return statement === undefined ? undefined : configObject(statement);
  } catch {
    return undefined;
  }
};

const resolveObject = (
  expression: ts.Expression,
  source: ts.SourceFile,
  visited = new Set<string>(),
): ts.ObjectLiteralExpression | undefined => {
  let value = expression;
  while (
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isParenthesizedExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value;
  }
  const device = resolveDevicePreset(value, source);
  if (device !== undefined) {
    return device;
  }
  if (!ts.isIdentifier(value) || visited.has(value.text)) {
    return undefined;
  }
  visited.add(value.text);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find(
      (entry) => ts.isIdentifier(entry.name) && entry.name.text === value.text,
    );
    if (declaration?.initializer !== undefined) {
      return resolveObject(declaration.initializer, source, visited);
    }
  }
  return undefined;
};

const numericValue = (expression: ts.Expression): number | undefined => {
  let value = expression;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) {
    value = value.expression;
  }
  return ts.isNumericLiteral(value) ? Number(value.text) : undefined;
};

const resolveVariable = (
  name: string,
  source: ts.SourceFile,
): ts.Expression | undefined => {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find(
      (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
    );
    if (declaration?.initializer !== undefined) {
      return declaration.initializer;
    }
  }
  return undefined;
};

const resolveArray = (
  expression: ts.Expression,
  source: ts.SourceFile,
  visited = new Set<string>(),
): ts.ArrayLiteralExpression | undefined => {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value) || visited.has(value.text)) {
    return undefined;
  }
  visited.add(value.text);
  const initializer = resolveVariable(value.text, source);
  return initializer === undefined
    ? undefined
    : resolveArray(initializer, source, visited);
};

const literalCommandPart = (
  expression: ts.Expression,
  source: ts.SourceFile,
  visited = new Set<string>(),
): string | undefined => {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  if (ts.isNumericLiteral(value)) {
    return value.text;
  }
  if (ts.isTemplateExpression(value)) {
    return value.getText(source);
  }
  if (!ts.isIdentifier(value) || visited.has(value.text)) {
    return undefined;
  }
  visited.add(value.text);
  const initializer = resolveVariable(value.text, source);
  return initializer === undefined
    ? undefined
    : literalCommandPart(initializer, source, visited);
};

const commandArray = (
  expression: ts.Expression,
  source: ts.SourceFile,
  visited = new Set<string>(),
): string[] | undefined => {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isIdentifier(value)) {
    if (visited.has(value.text)) {
      return undefined;
    }
    visited.add(value.text);
    const initializer = resolveVariable(value.text, source);
    return initializer === undefined
      ? undefined
      : commandArray(initializer, source, visited);
  }
  if (!ts.isArrayLiteralExpression(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const element of value.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = commandArray(element.expression, source, visited);
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
  call: ts.CallExpression,
  source: ts.SourceFile,
): string | undefined => {
  const expression = call.expression;
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(expression)) {
    name = expression.name.text;
  } else if (ts.isIdentifier(expression)) {
    name = expression.text;
  }
  if (name === undefined || !PROCESS_CALL_NAMES.has(name)) {
    return undefined;
  }
  const [first, second] = call.arguments;
  if (first === undefined) {
    return undefined;
  }
  if (ts.isObjectLiteralExpression(first)) {
    const command = first.properties.find(
      (member) =>
        ts.isPropertyAssignment(member) && propertyName(member.name) === "cmd",
    );
    if (command !== undefined && ts.isPropertyAssignment(command)) {
      const parts = commandArray(command.initializer, source);
      if (parts !== undefined) {
        return parts.join(" ");
      }
      return literalCommandPart(command.initializer, source);
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
  object: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): {
  explicit: boolean;
  value: number | undefined;
  unknownOverride: boolean;
} => {
  let explicit = false;
  let value: number | undefined;
  let unknownOverride = false;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spreadObject = resolveObject(member.expression, source);
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
    if (
      ts.isShorthandPropertyAssignment(member) &&
      member.name.text === "retries"
    ) {
      explicit = true;
      value = undefined;
      unknownOverride = false;
      continue;
    }
    if (
      !ts.isPropertyAssignment(member) ||
      propertyName(member.name) !== "retries"
    ) {
      if (
        ts.isPropertyAssignment(member) &&
        propertyName(member.name) === undefined &&
        (explicit || value !== undefined)
      ) {
        unknownOverride = true;
      }
      continue;
    }
    explicit = true;
    value = numericValue(member.initializer);
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
  expression: ts.Expression,
  source: ts.SourceFile,
): { objects: ts.ObjectLiteralExpression[]; unknownConfig: boolean } => {
  const objects: ts.ObjectLiteralExpression[] = [];
  const active = new Set<ts.Node>();
  let unknownConfig = false;
  const visitExpression = (
    value: ts.Expression,
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
    node: ts.Node,
    collect = true,
    projectElements = false,
  ): void => {
    if (active.has(node)) {
      unknownConfig = true;
      return;
    }
    active.add(node);
    if (ts.isObjectLiteralExpression(node)) {
      if (collect) {
        objects.push(node);
      }
      for (const member of node.properties) {
        if (ts.isSpreadAssignment(member)) {
          // The containing object's effectiveRetries already evaluates this
          // spread in order; inspect its children without judging overridden values.
          visitExpression(member.expression, true, false);
          continue;
        }
        let name: string | undefined;
        let initializer: ts.Expression | undefined;
        if (ts.isShorthandPropertyAssignment(member)) {
          name = member.name.text;
          initializer = member.name;
        } else if (ts.isPropertyAssignment(member)) {
          name = propertyName(member.name);
          initializer = member.initializer;
        }
        if (initializer === undefined) {
          continue;
        }
        visitExpression(
          initializer,
          name === "projects" || name === "use",
          true,
          name === "projects",
        );
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          visitExpression(element.expression, true, true, projectElements);
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
  const source = parseSource(file, sourceText);
  const diagnostics = ts.transpileModule(sourceText, {
    fileName: file,
    reportDiagnostics: true,
  }).diagnostics;
  if (
    diagnostics?.some(
      ({ category }) => category === ts.DiagnosticCategory.Error,
    )
  ) {
    return [{ file, message: "Playwright config has TypeScript parse errors" }];
  }
  const object = source.statements.map(configObject).find(Boolean);
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
  const source = parseSource(file, sourceText);
  const findings: TestRetryFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const command = processCommand(node, source);
      if (command !== undefined) {
        findings.push(
          ...scanCommand(file, command, "TS/JS process invocation"),
        );
      }
      const expression = node.expression;
      const isConfigure =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "configure" &&
        (expression.expression.getText(source) === "describe" ||
          expression.expression.getText(source) === "test.describe");
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
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
