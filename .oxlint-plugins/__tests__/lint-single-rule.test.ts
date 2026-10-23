import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  claimedBatches,
  holdSharedRunUntilPendingForTest,
  lintsAlone,
  lintSingleRule,
  runSingleRule,
  setLintRunnerForTest,
  sharedLines,
  sharedRuns,
} from "./lint-single-rule.ts";

const CODE = "plugin(rule)";
const FILES = ["/scratch/a/source.ts", "/scratch/b/source.ts"];
const SHARED_AWAIT_POINTS = [
  "mkdtemp",
  "realpath",
  "config-write",
  "source-write",
  "shared-ready",
] as const;

const nextTurn = async () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const completeWithin = async <T>(promise: Promise<T>, label: string) => {
  const expired = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    expired.reject(
      new Error(`Timed out waiting for ${label}`, {
        cause: new Error("A shared lint request remained unsettled"),
      }),
    );
  }, 1000);
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timeout);
  }
};

const fakeRunnerFor =
  (code: string, reportedText: string) => async (args: readonly string[]) => {
    const formatIndex = args.indexOf("json");
    const sourceFiles = args
      .slice(formatIndex + 1)
      .filter((argument) => argument !== "--fix");
    const diagnostics = (
      await Promise.all(
        sourceFiles.map(async (filename) => {
          const source = await Bun.file(filename).text();
          return source.split("\n").flatMap((line, index) =>
            line.includes(reportedText)
              ? [
                  {
                    code,
                    filename,
                    labels: [{ span: { line: index + 1 } }],
                  },
                ]
              : [],
          );
        }),
      )
    ).flat();
    return {
      stdout: JSON.stringify({
        diagnostics,
        number_of_files: sourceFiles.length,
        number_of_rules: 1,
      }),
      stderr: "",
      exitCode: diagnostics.length === 0 ? 0 : 1,
    };
  };

const sharedReport = (lines: readonly [string, number][]) =>
  JSON.stringify({
    diagnostics: lines.map(([filename, line]) => ({
      code: CODE,
      filename,
      labels: [{ span: { line } }],
    })),
    number_of_files: FILES.length,
    number_of_rules: 1,
  });

test("a shared run without reports is clean only when oxlint exits 0", () => {
  const stdout = sharedReport([]);
  expect(sharedLines({ stdout, stderr: "", exitCode: 2 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 1 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 0 }, FILES, CODE)).toEqual(
    [[], []],
  );
});

test("a shared run with reports is accepted only when oxlint exits 1", () => {
  const stdout = sharedReport([
    ["/scratch/b/source.ts", 3],
    ["/scratch/b/source.ts", 1],
  ]);
  expect(sharedLines({ stdout, stderr: "", exitCode: 1 }, FILES, CODE)).toEqual(
    [[], [1, 3]],
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 0 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 2 }, FILES, CODE)).toBe(
    null,
  );
});

test("parser failures cannot supply clean rule coverage", async () => {
  const result = await Result.tryPromise(
    async () =>
      await lintSingleRule("no-unsafe-inner-html", "const broken = ;", {
        sourcePath: "source.tsx",
      }),
  );
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain(
      "oxlint reported a parser or configuration error",
    );
  }
});

test("fix, scratch and override cases never share an oxlint run", () => {
  expect(lintsAlone({})).toBe(false);
  expect(lintsAlone({ cwd: "repository", fix: false })).toBe(false);
  expect(lintsAlone({ fix: true })).toBe(true);
  expect(lintsAlone({ cwd: "scratch" })).toBe(true);
  expect(lintsAlone({ overrides: [] })).toBe(true);
});

test("concurrent fix cases each return their isolated result", async () => {
  const source = 'const view = <div className="ml-2 text-right" />;';
  const isolated = {
    lines: [],
    source: 'const view = <div className="ms-2 text-end" />;',
  };
  const results = await Promise.all(
    Array.from({ length: 3 }, async () =>
      runSingleRule("no-physical-properties", source, {
        sourcePath: "source.tsx",
        fix: true,
      }),
    ),
  );
  expect(results).toEqual([isolated, isolated, isolated]);
});

test("a held cohort stays one batch across every pre-shared await interleaving", async () => {
  const plugin = "batching-sha256";
  const code = `${plugin}(no-raw-sha256)`;
  const hash = 'new Bun.CryptoHasher("sha256");';
  const sources = [
    'const clean = "sha256";',
    [hash, "const other = 1;", hash].join("\n"),
    ["const first = 1;", hash].join("\n"),
  ] as const;
  const restoreRunner = setLintRunnerForTest(
    code,
    fakeRunnerFor(code, 'Bun.CryptoHasher("sha256")'),
  );

  try {
    for (const point of SHARED_AWAIT_POINTS) {
      const releases = sources.map(() => Promise.withResolvers<undefined>());
      const decoysReady = Promise.withResolvers<undefined>();
      const targetTaken = Promise.withResolvers<undefined>();
      let readyDecoys = 0;
      const before = sharedRuns.filter((run) => run.code === code).length;
      holdSharedRunUntilPendingForTest(code, sources.length);
      const makeTarget = async (source: string, index: number) =>
        await lintSingleRule("no-raw-sha256", source, {
          plugin,
          settings: { batchingCohort: `target-${point}` },
          delayBeforeSharedAwaitForTest: async (current) => {
            if (current === point) {
              await releases[index]?.promise;
            }
          },
          ...(index === 0
            ? {
                onSharedBatchTakenForTest: () => {
                  targetTaken.resolve(undefined);
                },
              }
            : {}),
        });
      const target = [makeTarget(sources[0], 0)];
      const decoys = sources.map(async (source) =>
        lintSingleRule("no-raw-sha256", source, {
          plugin,
          settings: { batchingCohort: `decoy-${point}` },
          delayBeforeSharedAwaitForTest: async (current) => {
            if (current === "shared-ready") {
              readyDecoys += 1;
              if (readyDecoys === sources.length) {
                decoysReady.resolve(undefined);
              }
            }
          },
        }),
      );

      await decoysReady.promise;
      for (const [index, source] of sources.entries()) {
        if (index > 0) {
          target.push(makeTarget(source, index));
        }
      }
      releases[0]?.resolve(undefined);
      await targetTaken.promise;
      releases[1]?.resolve(undefined);
      releases[2]?.resolve(undefined);

      const [targetLines] = await Promise.all([
        Promise.all(target),
        Promise.all(decoys),
      ]);
      expect(targetLines).toEqual([[], [1, 3], [2]]);
      expect(
        sharedRuns.filter((run) => run.code === code).slice(before),
      ).toEqual([
        { code, cases: 3 },
        { code, cases: 3 },
      ]);
    }
  } finally {
    restoreRunner();
  }
});

test("seeded delay orders preserve lines in one held batch", async () => {
  const plugin = "batching-browser-storage";
  const code = `${plugin}(no-raw-browser-storage)`;
  const storage = "localStorage.getItem('key');";
  const sources = [
    'const clean = "storage";',
    [storage, "const other = 1;", storage].join("\n"),
    ["const first = 1;", storage].join("\n"),
  ];
  const restoreRunner = setLintRunnerForTest(
    code,
    fakeRunnerFor(code, "localStorage.getItem"),
  );
  let random = 0x5e_ed_12_34;
  const randomDelay = () => {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) % 0x1_00_00_00_00;
    if (random < 0) {
      random += 0x1_00_00_00_00;
    }
    return random % 4;
  };

  try {
    for (let seed = 0; seed < 8; seed += 1) {
      const delays = sources.map(() =>
        Object.fromEntries(
          SHARED_AWAIT_POINTS.map((point) => [point, randomDelay()]),
        ),
      );
      const before = sharedRuns.filter((run) => run.code === code).length;
      holdSharedRunUntilPendingForTest(code, sources.length);
      const results = await Promise.all(
        sources.map(async (source, index) =>
          lintSingleRule("no-raw-browser-storage", source, {
            plugin,
            settings: { batchingSeed: seed },
            delayBeforeSharedAwaitForTest: async (point) => {
              const turns = delays[index]?.[point] ?? 0;
              for (let turn = 0; turn < turns; turn += 1) {
                await nextTurn();
              }
            },
          }),
        ),
      );
      expect(results).toEqual([[], [1, 3], [2]]);
      expect(
        sharedRuns.filter((run) => run.code === code).slice(before),
      ).toEqual([{ code, cases: 3 }]);
    }
  } finally {
    restoreRunner();
  }
});

test("setup failures settle only their request and never retain the lint slot", async () => {
  const plugin = "batching-setup-failure";
  const code = `${plugin}(isolated-setup-failure)`;
  const reportedText = "reportSetupFailure";
  const sources = [
    `const clean = true;`,
    `${reportedText}();`,
    `const first = true;\n${reportedText}();`,
  ] as const;
  const restoreRunner = setLintRunnerForTest(
    code,
    fakeRunnerFor(code, reportedText),
  );

  try {
    for (const point of SHARED_AWAIT_POINTS) {
      holdSharedRunUntilPendingForTest(code, sources.length);
      const batch = sources.map(async (source, index) =>
        Result.tryPromise(async () =>
          lintSingleRule("isolated-setup-failure", source, {
            plugin,
            settings: { failedAt: point },
            delayBeforeSharedAwaitForTest: async (current) => {
              if (index === 1 && current === point) {
                throw new Error(`injected ${point} setup failure`);
              }
            },
          }),
        ),
      );
      const results = await completeWithin(
        Promise.all(batch),
        `${point} setup-failure batch`,
      );
      expect(results[0]?.isOk() && results[0].value).toEqual([]);
      expect(results[1]?.isErr() && results[1].error.message).toContain(
        `injected ${point} setup failure`,
      );
      expect(results[2]?.isOk() && results[2].value).toEqual([2]);

      holdSharedRunUntilPendingForTest(code, 2);
      const following = await completeWithin(
        Promise.all(
          [sources[0], sources[2]].map(async (source) =>
            lintSingleRule("isolated-setup-failure", source, {
              plugin,
              settings: { followsFailureAt: point },
            }),
          ),
        ),
        `${point} following shared run`,
      );
      expect(following).toEqual([[], [2]]);
    }
  } finally {
    restoreRunner();
  }
});

test("a rejected shared run falls back to lone runs and is not counted as shared", async () => {
  const code = "no-raw-date-parsing(no-raw-date-parsing)";
  const sharedBefore = sharedRuns.filter((run) => run.code === code).length;
  const claimedBefore = claimedBatches.filter(
    (batch) => batch.code === code,
  ).length;
  holdSharedRunUntilPendingForTest(code, 3);
  const dateOnly = 'const parsed = new Date("2024-01-01");';
  // The unparsable case adds a diagnostic that is not this rule's, so the
  // shared report is rejected and every case reruns alone.
  const results = await Promise.all(
    [
      dateOnly,
      "const broken = ;",
      ["const first = 1;", dateOnly].join("\n"),
    ].map(
      async (source) =>
        await Result.tryPromise(async () =>
          lintSingleRule("no-raw-date-parsing", source),
        ),
    ),
  );
  expect(results[0]?.isOk() && results[0].value).toEqual([1]);
  expect(results[2]?.isOk() && results[2].value).toEqual([2]);
  expect(
    claimedBatches.filter((batch) => batch.code === code).slice(claimedBefore),
  ).toEqual([{ code, cases: 3 }]);
  expect(
    sharedRuns.filter((run) => run.code === code).slice(sharedBefore),
  ).toEqual([]);
});
