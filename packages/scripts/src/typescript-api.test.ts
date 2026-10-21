import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isImportDeclaration,
  isNamedImports,
  SyntaxKind,
} from "typescript/unstable/ast";

import { openProgram, parseSource, parseTsconfig } from "./typescript-api";

const createRealProject = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "typescript-api-"));
  const configPath = path.join(directory, "tsconfig.json");
  const valuePath = path.join(directory, "value.ts");
  const consumerPath = path.join(directory, "consumer.ts");
  await Promise.all([
    writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { strict: true, target: "es2022" },
        files: ["consumer.ts"],
      }),
    ),
    writeFile(valuePath, "export const importedValue: string = 'value';"),
    writeFile(
      consumerPath,
      'import { importedValue } from "./value";\nexport const result = importedValue;',
    ),
  ]);
  return { directory, configPath, valuePath, consumerPath };
};

test("parses in-memory TypeScript with the shared asynchronous API", async () => {
  const parsed = await parseSource(
    "/virtual/typescript-api/first.ts",
    "export const answer: number = 42;",
  );

  expect(parsed.status).toBe("ok");
  if (parsed.status === "error") {
    return;
  }
  expect(parsed.value.statements.at(0)?.kind).toBe(
    SyntaxKind.VariableStatement,
  );
});

test("reuses the API while keeping virtual source text isolated by path", async () => {
  const first = await parseSource(
    "/virtual/typescript-api/reused.ts",
    "export const value = 'first';",
  );
  const second = await parseSource(
    "/virtual/typescript-api/reused.ts",
    "export const value = 'second';",
  );

  expect(first.status).toBe("ok");
  expect(second.status).toBe("ok");
  if (second.status === "error") {
    return;
  }
  expect(second.value.text).toContain("'second'");
});

test("fails closed when no root files can define a program", async () => {
  const opened = await openProgram({ roots: [] });

  expect(opened.status).toBe("error");
  if (opened.status === "ok") {
    return;
  }
  expect(opened.error.capability).toBe("a TypeScript program and checker");
  expect(opened.error.cause).toBeInstanceOf(Error);
});

test("resolves an imported symbol from a real project", async () => {
  const { directory, configPath, consumerPath } = await createRealProject();

  try {
    const opened = await openProgram({ configPath });
    expect(opened.status).toBe("ok");
    if (opened.status === "error") {
      return;
    }

    const consumer = await opened.value.program.getSourceFile(consumerPath);
    expect(consumer).toBeDefined();
    const importDeclaration = consumer?.statements.find(isImportDeclaration);
    expect(importDeclaration).toBeDefined();
    if (importDeclaration === undefined) {
      return;
    }
    const namedBindings = importDeclaration.importClause?.namedBindings;
    expect(namedBindings !== undefined && isNamedImports(namedBindings)).toBe(
      true,
    );
    if (namedBindings === undefined || !isNamedImports(namedBindings)) {
      return;
    }
    const importedName = namedBindings.elements.at(0)?.name;
    expect(importedName).toBeDefined();
    if (importedName === undefined) {
      return;
    }
    const symbol = await opened.value.checker.getSymbolAtLocation(importedName);
    expect(symbol).toBeDefined();
    if (symbol === undefined) {
      return;
    }
    const type = await opened.value.checker.getTypeOfSymbol(symbol);
    expect(type).toBeDefined();
    if (type === undefined) {
      return;
    }
    expect(await opened.value.checker.typeToString(type)).toBe("string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses compiler options from a real tsconfig", async () => {
  const { directory, configPath } = await createRealProject();

  try {
    const parsedConfig = await parseTsconfig(configPath);
    expect(parsedConfig.status).toBe("ok");
    if (parsedConfig.status === "error") {
      return;
    }
    expect(parsedConfig.value.options["strict"]).toBe(true);
    expect(parsedConfig.value.options["target"]).toBe(9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses in-memory text while a real project remains open", async () => {
  const { directory, configPath, valuePath } = await createRealProject();

  try {
    const opened = await openProgram({ configPath });
    expect(opened.status).toBe("ok");
    if (opened.status === "error") {
      return;
    }

    const parsedSource = await parseSource(
      "/virtual/typescript-api/while-real-project-open.ts",
      "export const virtualOnly: boolean = true;",
    );
    expect(parsedSource.status).toBe("ok");
    if (parsedSource.status === "error") {
      return;
    }
    expect(parsedSource.value.text).toContain("virtualOnly");
    expect(await opened.value.program.getSourceFile(valuePath)).toBeDefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
