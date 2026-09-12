import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const RULE_NAME = "no-unreviewed-typebox-unsafe";
const RULE_ID = `${RULE_NAME}/${RULE_NAME}`;
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

type ApprovedAdapter = {
  binding: string;
  path: string;
  reason: string;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const reportedLine = (diagnostic: unknown): number | null => {
  if (!isRecord(diagnostic) || typeof diagnostic["code"] !== "string") {
    return null;
  }
  if (!diagnostic["code"].startsWith(`${RULE_NAME}(`)) {
    return null;
  }
  const label = isUnknownArray(diagnostic["labels"])
    ? diagnostic["labels"].at(0)
    : undefined;
  const span = isRecord(label) ? label["span"] : undefined;
  const line = isRecord(span) ? span["line"] : undefined;
  return typeof line === "number" ? line : null;
};

const lintSources = async ({
  approvedAdapters,
  sources,
}: {
  approvedAdapters: readonly ApprovedAdapter[];
  sources: readonly { source: string; sourceName: string }[];
}): Promise<number[]> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-typebox-unsafe-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      rules: {
        [RULE_ID]: ["error", { approvedAdapters }],
      },
    })};\n`,
  );
  const sourcePaths: string[] = [];
  for (const { source, sourceName } of sources) {
    const sourcePath = path.join(directory, sourceName);
    sourcePaths.push(sourcePath);
    await Bun.write(sourcePath, source);
  }

  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "-f",
      "json",
      ...sourcePaths,
    ],
    { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
  if (exitCode !== 0 && exitCode !== 1) {
    return panic(`oxlint exited with status ${exitCode}:\n${output}`);
  }
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(report)) {
    return panic(`oxlint did not produce valid JSON:\n${output}`);
  }
  const diagnostics = isRecord(report.value)
    ? report.value["diagnostics"]
    : undefined;
  if (!isUnknownArray(diagnostics)) {
    return panic(`oxlint reported no diagnostics array:\n${output}`);
  }
  return diagnostics
    .map(reportedLine)
    .filter((line): line is number => line !== null)
    .sort((left, right) => left - right);
};

const lint = async ({
  approvedAdapters,
  source,
  sourceName,
}: {
  approvedAdapters: readonly ApprovedAdapter[];
  source: string;
  sourceName: string;
}): Promise<number[]> =>
  await lintSources({
    approvedAdapters,
    sources: [{ source, sourceName }],
  });

const approvedAdapter = (
  binding: string,
  reason = "Fixture-approved adapter boundary.",
): ApprovedAdapter => ({
  binding,
  path: "approved.ts",
  reason,
});

describe.serial("no-unreviewed-typebox-unsafe approved adapters", () => {
  test("permits only the reviewed TypeBox call", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => Type.Unsafe(runtimeSchema);",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([]);
  });

  test("tracks destructured aliases from imports without trusting shadows", async () => {
    const source = [
      'import { Type, Unsafe as importedUnsafe } from "@sinclair/typebox";',
      'import * as TypeBox from "@sinclair/typebox";',
      'import * as Elysia from "elysia";',
      "const { Unsafe } = Type;",
      "Unsafe(runtimeSchema);",
      "const { Unsafe: renamedUnsafe } = Type;",
      "renamedUnsafe(runtimeSchema);",
      "const { Type: { Unsafe: nestedTypeboxUnsafe } } = TypeBox;",
      "nestedTypeboxUnsafe(runtimeSchema);",
      "const { t: { Unsafe: nestedElysiaUnsafe } } = Elysia;",
      "nestedElysiaUnsafe(runtimeSchema);",
      "const { t: elysiaSchema } = Elysia;",
      "elysiaSchema.Unsafe(runtimeSchema);",
      "const { String: nonSchema } = Type;",
      "nonSchema.Unsafe(runtimeSchema);",
      "importedUnsafe(runtimeSchema);",
      "const useLocalUnsafe = (Unsafe: (schema: unknown) => unknown) => Unsafe(runtimeSchema);",
      "const useLocalType = (Type: { Unsafe: (schema: unknown) => unknown }) => { const { Unsafe } = Type; return Unsafe(runtimeSchema); };",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [],
        source,
        sourceName: "unapproved.ts",
      }),
    ).toEqual([5, 7, 9, 11, 13, 16]);
  });

  test("does not let an approved outer adapter hide a nested Unsafe call last", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => [",
      "  Type.Unsafe(runtimeSchema),",
      "  (() => Type.Unsafe(runtimeSchema))(),",
      "];",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([4]);
  });

  test("does not let an approved outer adapter hide a nested Unsafe call first", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => [",
      "  (() => Type.Unsafe(runtimeSchema))(),",
      "  Type.Unsafe(runtimeSchema),",
      "];",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([3]);
  });

  test("rejects the sole Unsafe call in an anonymous child callback", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => (() => Type.Unsafe(runtimeSchema))();",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([1, 2]);
  });

  test("keeps unreviewed bindings and unmatched approvals rejected", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => Type.Unsafe(runtimeSchema);",
      "export const unreviewed = () => Type.Unsafe(runtimeSchema);",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [
          approvedAdapter("reviewed"),
          approvedAdapter("removedAdapter"),
        ],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([1, 3]);
    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "unapproved.ts",
      }),
    ).toEqual([2, 3]);
  });

  test("does not approve a nested binding with the reviewed name", async () => {
    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        sourceName: "approved.ts",
        source:
          'import { Type } from "typebox";\nfunction outer() { const reviewed = () => Type.Unsafe(runtimeSchema); return reviewed; }',
      }),
    ).toEqual([1, 2]);
  });

  test("rejects approvals after adapter changes", async () => {
    const cases = [
      [
        "a renamed binding",
        [
          'import { Type } from "@sinclair/typebox";',
          "export const renamed = () => Type.Unsafe(runtimeSchema);",
          "",
        ].join("\n"),
        [1, 2],
      ],
      ["a removed binding", 'import { Type } from "@sinclair/typebox";\n', [1]],
      [
        "a TypeBox builder replacing Unsafe",
        [
          'import { Type } from "@sinclair/typebox";',
          "export const reviewed = () => Type.String();",
          "",
        ].join("\n"),
        [1],
      ],
      [
        "a source file with no TypeBox usage",
        "export const reviewed = () => undefined;\n",
        [1],
      ],
    ] as const;

    for (const [, source, expectedLines] of cases) {
      expect(
        await lint({
          approvedAdapters: [approvedAdapter("reviewed")],
          source,
          sourceName: "approved.ts",
        }),
      ).toEqual([...expectedLines]);
    }
  });

  test("rejects duplicate approvals instead of choosing one", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => Type.Unsafe(runtimeSchema);",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [
          approvedAdapter("reviewed"),
          approvedAdapter("reviewed"),
        ],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([1, 2]);
  });

  test("rejects an empty adapter reason in configuration", async () => {
    const invalidConfiguration = await Result.tryPromise({
      try: async () =>
        await lint({
          approvedAdapters: [approvedAdapter("reviewed", "")],
          source: 'import { Type } from "@sinclair/typebox";\n',
          sourceName: "approved.ts",
        }),
      catch: (cause) => cause,
    });

    if (!Result.isError(invalidConfiguration)) {
      panic("an empty adapter reason unexpectedly passed validation");
    }
    if (!(invalidConfiguration.error instanceof Error)) {
      panic("an empty adapter reason produced a non-Error failure");
    }
    expect(invalidConfiguration.error.message).toContain(
      "Options validation failed",
    );
  });

  test("does not let a whitespace-only adapter reason grant an exemption", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => Type.Unsafe(runtimeSchema);",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed", " \t ")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([2]);
  });

  test("continues to reject an extra direct Unsafe call for an approved binding", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => [",
      "  Type.Unsafe(firstRuntimeSchema),",
      "  Type.Unsafe(secondRuntimeSchema),",
      "];",
      "",
    ].join("\n");

    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source,
        sourceName: "approved.ts",
      }),
    ).toEqual([4]);
  });

  test("does not apply approvals from an unrelated path", async () => {
    expect(
      await lint({
        approvedAdapters: [approvedAdapter("reviewed")],
        source: "export const unrelated = undefined;\n",
        sourceName: "other.ts",
      }),
    ).toEqual([]);
  });

  test("resets applicable approval consumption between files", async () => {
    const source = [
      'import { Type } from "@sinclair/typebox";',
      "export const reviewed = () => Type.Unsafe(runtimeSchema);",
      "",
    ].join("\n");

    expect(
      await lintSources({
        approvedAdapters: [
          approvedAdapter("reviewed"),
          {
            ...approvedAdapter("reviewed"),
            path: "other.ts",
          },
        ],
        sources: [
          { source, sourceName: "approved.ts" },
          { source, sourceName: "other.ts" },
        ],
      }),
    ).toEqual([]);
  });
});
