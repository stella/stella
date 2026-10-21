import { expect, test } from "bun:test";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Snapshot } from "typescript/unstable/async";

import {
  type ParsedSources,
  type TypeScriptSession,
  withTypeScriptSession,
} from "./typescript-api";

const FIRST = {
  fileName: "/virtual/typescript-api/first.ts",
  text: "export const first: number = 1;",
};
const SECOND = {
  fileName: "/virtual/typescript-api/second.ts",
  text: "import { first } from './first';\nexport const second = first;",
};

const parsedValue = (
  parsed: Awaited<ReturnType<TypeScriptSession["parseSources"]>>,
): ParsedSources => {
  if (parsed.status === "error") {
    throw parsed.error;
  }
  return parsed.value;
};

test("parses many sources into one snapshot, in request order", async () => {
  const outcome = await withTypeScriptSession(async (session) => {
    const { snapshot, sourceFiles } = parsedValue(
      await session.parseSources([FIRST, SECOND]),
    );
    expect(snapshot.getProjects()).toHaveLength(1);
    expect(sourceFiles.map((sourceFile) => sourceFile.fileName)).toEqual([
      FIRST.fileName,
      SECOND.fileName,
    ]);
    expect(
      sourceFiles.map((sourceFile) => sourceFile.statements[0]?.kind),
    ).toEqual([SyntaxKind.VariableStatement, SyntaxKind.ImportDeclaration]);
  });

  expect(outcome.status).toBe("ok");
});

test("closes the session after use returns", async () => {
  let escaped: { session: TypeScriptSession; snapshot: Snapshot } | undefined;
  const outcome = await withTypeScriptSession(async (session) => {
    const { snapshot } = parsedValue(await session.parseSources([FIRST]));
    escaped = { session, snapshot };
  });

  expect(outcome.status).toBe("ok");
  expect(escaped?.snapshot.isDisposed()).toBe(true);
  expect((await escaped?.session.parseSources([FIRST]))?.status).toBe("error");
});

test("closes the session when use throws", async () => {
  let escaped: { session: TypeScriptSession; snapshot: Snapshot } | undefined;
  const thrown = new Error("caller failure");

  // A try/catch rather than `expect().rejects`, which stalls the API's
  // child-process IO under bun test.
  let caught: unknown;
  try {
    await withTypeScriptSession(async (session) => {
      const { snapshot } = parsedValue(await session.parseSources([FIRST]));
      escaped = { session, snapshot };
      throw thrown;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(thrown);
  expect(escaped?.snapshot.isDisposed()).toBe(true);
  expect((await escaped?.session.parseSources([FIRST]))?.status).toBe("error");
});
