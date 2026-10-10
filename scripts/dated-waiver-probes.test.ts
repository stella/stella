import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import {
  removeWaiver,
  runWaiverProbe,
  probeDocUrl,
  createProbeBudget,
  PROBE_PHASE_BUDGET_MS,
  PROBE_TIMEOUT_MS,
} from "./dated-waiver-probes";
import { readTestQuarantines, type DatedWaiver } from "./dated-waivers";

const waiver = (
  kind: DatedWaiver["kind"],
  source: string,
  id = "package",
): DatedWaiver => ({
  kind,
  source,
  id,
  line: 2,
  expiresAt: "2026-10-05T00:00:00.000Z",
  probe: {
    command: [
      "bun",
      "scripts/dated-waiver-probes.ts",
      "--doc-url",
      "https://example.com/llms.txt",
    ],
    attempts: 3,
  },
});
const reader = (sources: Readonly<Record<string, string>>) => (file: string) =>
  sources[file] ?? "";

test("green needs every stress sample and one red remains red without early exit", async () => {
  for (const attempts of [3, 20]) {
    for (const redAt of [-1, 0, attempts - 1]) {
      let calls = 0;
      const entry = {
        ...waiver("dependency-audit", "baseline.json"),
        probe: { command: ["bun", "run", "security:audit"], attempts },
      };
      const evidence = await runWaiverProbe(entry, {
        run: async () => ({
          passed: calls++ !== redAt,
          output: "private failure",
        }),
      });
      expect(calls).toBe(attempts);
      expect(evidence.status).toBe(redAt === -1 ? "green" : "red");
      expect(evidence.passed).toBe(redAt === -1 ? attempts : attempts - 1);
      expect(evidence.output).toBe(
        redAt === -1 ? "" : "Sample 1:\nprivate failure",
      );
    }
  }
});
test("network errors and absent canonical URLs fail closed without sensitive messages", async () => {
  for (const status of [200, 404, 429, 500]) {
    expect(
      (
        await probeDocUrl(
          "https://example.com/llms.txt",
          async () => new Response("", { status }),
        )
      ).passed,
    ).toBe(status === 200);
  }
  expect((await probeDocUrl("", async () => new Response(""))).passed).toBe(
    false,
  );
  expect(
    (
      await probeDocUrl("https://example.com/llms.txt", async () => {
        throw new TypeError("sensitive details");
      })
    ).output,
  ).toBe("Documentation endpoint request failed.");
});
test("AST docs edits preserve comments, unrelated objects, separators and remaining dates", () => {
  for (const separator of [",", " /* retained, */ ,", " // retained\n,"]) {
    const source = `export const DOC_SOURCES = { existing: { dependencies: ["other"], url: "https://other.com/llms.txt" } /* registry comment */ } as const;\nexport const DOC_SOURCE_EXCLUSIONS = [].concat({ dependency: "package", expiresAt: "2026-10-05T00:00:00.000Z" }${separator}{ dependency: "other", expiresAt: "2026-10-06T00:00:00.000Z" });\nconst unrelated = { dependency: "package" };`;
    const changed =
      removeWaiver(
        waiver("no-llms-txt", ".claude/mcp/doc-sources.ts"),
        reader({ ".claude/mcp/doc-sources.ts": source }),
      ).at(0)?.after ?? "";
    expect(changed).toContain('const unrelated = { dependency: "package" }');
    expect(changed).toContain("registry comment");
    expect(changed).toContain('expiresAt: "2026-10-06T00:00:00.000Z"');
    expect(changed).not.toContain('expiresAt: "2026-10-05T00:00:00.000Z"');
    expect(changed).toContain('url: "https://example.com/llms.txt"');
    expect(
      ts
        .transpileModule(changed, { reportDiagnostics: true })
        .diagnostics?.filter(
          ({ category }) => category === ts.DiagnosticCategory.Error,
        ) ?? [],
    ).toEqual([]);
  }
  expect(() =>
    removeWaiver(
      waiver("no-llms-txt", ".claude/mcp/doc-sources.ts"),
      reader({ ".claude/mcp/doc-sources.ts": "const broken = {" }),
    ),
  ).toThrow("does not parse");
});
test("release-age and audit removals retain every other date and never write later dates", () => {
  const fixtures = [
    {
      entry: waiver("release-age-exclusion", "bunfig.toml"),
      content:
        '[install]\n "package", # quarantine-expires: 2026-10-05T00:00:00.000Z\n "other", # quarantine-expires: 2026-10-06T00:00:00.000Z',
      retained: "2026-10-06T00:00:00.000Z",
    },
    {
      entry: waiver("dependency-audit", "baseline.json"),
      content:
        '{"accepted":[{"id":"package","expiresOn":"2026-10-05"},{"id":"other","expiresOn":"2026-10-06"}]}',
      retained: "2026-10-06",
    },
    {
      entry: waiver(
        "release-age-exception",
        "docker-compose.yml",
        "docker-compose.yml:2",
      ),
      content:
        "command: bun install --minimum-release-age 0\n# release-age-quarantine-exception: 2026-10-05T00:00:00.000Z\n# retained: 2026-10-06T00:00:00.000Z",
      retained: "2026-10-06T00:00:00.000Z",
    },
  ];
  for (const { entry, content, retained } of fixtures) {
    const changed =
      removeWaiver(entry, reader({ [entry.source]: content })).at(0)?.after ??
      "";
    expect(changed).toContain(retained);
    expect(changed).not.toContain("2026-10-05");
    expect(changed).not.toContain("--minimum-release-age 0");
    const originalDates = new Set(content.match(/\d{4}-\d{2}-\d{2}/gu));
    for (const date of changed.match(/\d{4}-\d{2}-\d{2}/gu) ?? []) {
      expect(originalDates.has(date)).toBe(true);
    }
  }
  expect(() =>
    removeWaiver(
      waiver("dependency-audit", "baseline.json"),
      reader({
        "baseline.json": '{"accepted":[{"id":"package"},{"id":"package"}]}',
      }),
    ),
  ).toThrow("not unique");
});
test("suppression removal deletes the waiver and only its anchored directive rule", () => {
  const entry = {
    ...waiver(
      "suppression-waiver",
      "scripts/suppression-waivers.json",
      "SW-0001",
    ),
    expiresAt: "2026-10-05",
  };
  const source =
    "// eslint-disable-next-line require-search-scope/require-search-scope, other/rule -- retained reason\nexport const example = () => 1;\n// eslint-disable-next-line require-search-scope/require-search-scope -- different owner\nexport const unrelated = () => 2;";
  const ledger = JSON.stringify({
    waivers: [
      {
        id: "SW-0001",
        kind: "temporary",
        rule: "require-search-scope/require-search-scope",
        file: "example.ts",
        symbol: "example",
        count: 1,
        reason: "fixture",
        evidence: "example.test.ts",
        expires: "2026-10-05",
      },
    ],
  });
  const changed = removeWaiver(
    entry,
    reader({ [entry.source]: ledger, "example.ts": source }),
  );
  expect(changed.find(({ source: file }) => file === entry.source)?.after).toBe(
    '{\n  "waivers": []\n}\n',
  );
  expect(
    changed.find(({ source: file }) => file === "example.ts")?.after,
  ).toContain("// eslint-disable-next-line other/rule -- retained reason");
  expect(
    changed.find(({ source: file }) => file === "example.ts")?.after,
  ).toContain("require-search-scope/require-search-scope -- different owner");
  expect(
    changed.flatMap(({ after }) => after.match(/\d{4}-\d{2}-\d{2}/gu) ?? []),
  ).toEqual([]);
});
test("test quarantine removal unmasks only its exact dated test and removes its deadline", () => {
  const source =
    '// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("case", () => {});\ntest.skip("other", () => {});';
  const entry = readTestQuarantines({ "a.test.ts": source }).at(0);
  if (!entry) {
    throw new TypeError("fixture quarantine missing");
  }
  const changed =
    removeWaiver(entry, reader({ "a.test.ts": source })).at(0)?.after ?? "";
  expect(changed).toContain('test("case",');
  expect(changed).toContain('test.skip("other",');
  expect(readTestQuarantines({ "a.test.ts": changed })).toEqual([]);
  expect(changed).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
});

test("command launch failures become private red evidence for all N samples", async () => {
  let launches = 0;
  const evidence = await runWaiverProbe(
    waiver("dependency-audit", "baseline.json"),
    {
      run: async () => {
        launches += 1;
        throw new TypeError("missing executable; private details");
      },
    },
  );
  expect(launches).toBe(3);
  expect(evidence.status).toBe("red");
  expect(evidence.passed).toBe(0);
  expect(evidence.output).toContain("Failed to execute probe command.");
  expect(evidence.output).not.toContain("private details");
});

test("test green requires exactly one named passing selected receipt", async () => {
  for (const [output, expected] of [
    ["0 pass\n0 fail", "red"],
    ["1 pass\n0 skip\n0 fail", "red"],
    [
      "(pass) package [0.10ms]\n(skip) unrelated\n1 pass\n1 skip\n0 fail",
      "green",
    ],
    [
      "(pass) group > package [0.10ms]\n(skip) group > unrelated\n1 pass\n1 skip\n0 fail",
      "green",
    ],
    ["(skip) package\n(pass) other [0.10ms]\n1 pass\n1 skip\n0 fail", "red"],
    ["(pass) package [0.10ms]\n(pass) package [0.20ms]\n2 pass\n0 fail", "red"],
    ["\u001b[32m(pass)\u001b[0m package [0.10ms]\n1 pass\n0 fail", "green"],
  ] as const) {
    const evidence = await runWaiverProbe(
      waiver("quarantined-test", "a.test.ts"),
      {
        run: async () => ({ passed: true, output }),
      },
    );
    expect(evidence.status).toBe(expected);
  }
});

test("real Bun filtered receipts accept only the selected passing declaration", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "dated-waiver-bun-receipt-"),
  );
  const source = path.join(directory, "receipt.test.ts");
  const selected =
    '// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("selected", () => expect(1).toBe(1));';
  const neighbor = 'test("neighbor", () => expect(2).toBe(2));';
  const cases = [
    {
      contents: `${selected}\n${neighbor}`,
      status: "green",
      receipt: "filtered out",
    },
    {
      contents: `${selected}\ntest.skip("selected neighbor", () => expect(2).toBe(2));`,
      status: "green",
      receipt: "(skip) selected neighbor",
    },
    {
      contents: `describe("group", () => {\n${selected}\n${neighbor}\n});`,
      status: "green",
      receipt: "filtered out",
    },
    {
      contents: `describe.skip("group", () => {\n${selected}\n});\n${neighbor}`,
      status: "red",
      receipt: "(skip) group > selected",
    },
    {
      contents: `${selected}\ntest("selected", () => expect(3).toBe(3));\n${neighbor}`,
      status: "red",
      receipt: "filtered out",
    },
  ] as const;
  try {
    for (const fixture of cases) {
      writeFileSync(
        source,
        `import { describe, expect, test } from "bun:test";\n${fixture.contents}\n`,
      );
      const entry = readTestQuarantines({
        [source]: readFileSync(source, "utf-8"),
      }).at(0);
      if (!entry) {
        throw new TypeError("Fixture quarantine missing");
      }
      for (const change of removeWaiver(entry, (file) =>
        readFileSync(file, "utf-8"),
      )) {
        writeFileSync(change.source, change.after);
      }
      // One real sample proves receipt classification; the stress-count matrix
      // separately verifies every production attempt is collected.
      const sample = {
        ...entry,
        probe: { command: entry.probe.command, attempts: 1 },
      };
      let captured = "";
      const evidence = await runWaiverProbe(sample, {
        run: async (command) => {
          const result = Bun.spawnSync([...command], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, FORCE_COLOR: "0" },
            timeout: 30_000,
          });
          captured = result.stdout.toString() + result.stderr.toString();
          return { passed: result.exitCode === 0, output: captured };
        },
      });
      expect(captured).toContain(fixture.receipt);
      expect(evidence.status).toBe(fixture.status);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("equal test deadlines remove only the matching declaration's marker", () => {
  const source =
    '// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("first", () => {});\n// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("second", () => {});';
  const entries = readTestQuarantines({ "a.test.ts": source });
  const second = entries.find(({ id }) => id === "second");
  if (!second) {
    throw new TypeError("fixture quarantine missing");
  }
  const changed =
    removeWaiver(second, reader({ "a.test.ts": source })).at(0)?.after ?? "";
  expect(
    readTestQuarantines({ "a.test.ts": changed }).map(({ id }) => id),
  ).toEqual(["first"]);
  expect(changed).toContain('test("second",');
});

test("suppression removal reads only listed relative paths", () => {
  const entry = {
    ...waiver(
      "suppression-waiver",
      "scripts/suppression-waivers.json",
      "SW-0001",
    ),
    expiresAt: "2026-10-05",
  };
  const files = new Map([
    [
      entry.source,
      JSON.stringify({
        waivers: [
          {
            id: entry.id,
            kind: "temporary",
            rule: "require-search-scope/require-search-scope",
            file: "example.ts",
            symbol: "example",
            count: 1,
            reason: "fixture",
            evidence: "example.test.ts",
            expires: entry.expiresAt,
          },
        ],
      }),
    ],
    [
      "example.ts",
      "// eslint-disable-next-line require-search-scope/require-search-scope -- fixture invariant\nexport const example = () => 1;",
    ],
  ]);
  const reads: string[] = [];
  const changes = removeWaiver(entry, (file) => {
    reads.push(file);
    const contents = files.get(file);
    if (contents === undefined) {
      throw new TypeError("Unlisted fixture file");
    }
    return contents;
  });
  expect(reads).toEqual([...files.keys()]);
  expect(changes.map(({ source }) => source)).toEqual([...files.keys()]);
});

test("twenty sequential command timeouts fit one global phase deadline", async () => {
  let elapsed = 0;
  const budget = createProbeBudget({ attempts: 20, now: () => elapsed });
  const timeouts: number[] = [];
  const entry = {
    ...waiver("dependency-audit", "baseline.json"),
    probe: { command: ["bun", "run", "security:audit"], attempts: 20 },
  };
  const evidence = await runWaiverProbe(entry, {
    run: async (command) =>
      budget.run(command, async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        elapsed += timeoutMs;
        return {
          passed: false,
          output: `Probe timed out after ${timeoutMs}ms.`,
        };
      }),
  });
  expect(timeouts).toHaveLength(20);
  expect(evidence.status).toBe("red");
  expect(evidence.attempts).toBe(20);
  expect(evidence.passed).toBe(0);
  expect(evidence.output).toContain("Probe timed out");
  expect(elapsed).toBeLessThanOrEqual(PROBE_PHASE_BUDGET_MS);
  expect(Math.max(...timeouts)).toBeLessThanOrEqual(PROBE_TIMEOUT_MS);
});

test("an exhausted shared phase records every later sample without launching commands", async () => {
  let clock = 0;
  const budget = createProbeBudget({ attempts: 6, now: () => clock });
  clock = PROBE_PHASE_BUDGET_MS;
  let launches = 0;
  const execute = async () => {
    launches += 1;
    return { passed: true, output: "" };
  };
  for (const id of ["first", "later"]) {
    const evidence = await runWaiverProbe(
      waiver("dependency-audit", "baseline.json", id),
      { run: async (command) => budget.run(command, execute) },
    );
    expect(evidence.status).toBe("red");
    expect(evidence.attempts).toBe(3);
    expect(evidence.passed).toBe(0);
    expect(
      evidence.output.match(
        /Probe phase budget exhausted; no command was launched\./gu,
      ),
    ).toHaveLength(3);
  }
  expect(launches).toBe(0);
});

test("preparation consumes the existing deadline and fast probes release time to later samples", async () => {
  let clock = 0;
  const budget = createProbeBudget({ attempts: 20, now: () => clock });
  clock += 5 * 60_000;
  const timeouts: number[] = [];
  const execute = async ({ timeoutMs }: { timeoutMs: number }) => {
    timeouts.push(timeoutMs);
    clock += 1000;
    return { passed: true, output: "" };
  };
  const first = await budget.run(["bun", "probe"], execute);
  const later = await budget.run(["bun", "probe"], execute);
  expect(first.passed).toBe(true);
  expect(later.passed).toBe(true);
  expect(timeouts.at(0)).toBe(
    Math.floor((PROBE_PHASE_BUDGET_MS - 5 * 60_000) / 20),
  );
  expect(timeouts.at(1)).toBe(
    Math.floor((PROBE_PHASE_BUDGET_MS - 5 * 60_000 - 1000) / 19),
  );
  expect(timeouts.at(1)).toBeGreaterThan(timeouts.at(0) ?? 0);
  clock += PROBE_PHASE_BUDGET_MS;
  const exhausted = await budget.run(["bun", "probe"], execute);
  expect(exhausted).toEqual({
    passed: false,
    output: "Probe phase budget exhausted; no command was launched.",
  });
  expect(timeouts).toHaveLength(2);
});

test("individual commands keep the ten minute ceiling and attempt inventory cannot be exceeded", async () => {
  const budget = createProbeBudget({ attempts: 1, now: () => 0 });
  const timeouts: number[] = [];
  const execute = async ({ timeoutMs }: { timeoutMs: number }) => {
    timeouts.push(timeoutMs);
    return { passed: true, output: "" };
  };
  expect((await budget.run(["bun", "probe"], execute)).passed).toBe(true);
  expect((await budget.run(["bun", "probe"], execute)).passed).toBe(false);
  expect(timeouts).toEqual([PROBE_TIMEOUT_MS]);
  for (const attempts of [-1, 0.5, Number.NaN]) {
    expect(() => createProbeBudget({ attempts })).toThrow(
      "nonnegative integer attempt count",
    );
  }
});

test("a completed command cannot report green after consuming its entire allocation", async () => {
  let clock = 0;
  const budget = createProbeBudget({ attempts: 3, now: () => clock });
  const result = await budget.run(["bun", "probe"], async ({ timeoutMs }) => {
    clock += timeoutMs + 1;
    return { passed: true, output: "completed command output" };
  });
  expect(result.passed).toBe(false);
  expect(result.output).toContain("Probe timed out after");
  expect(result.output).toContain("completed command output");
  const empty = createProbeBudget({ attempts: 0, now: () => clock });
  let launched = false;
  expect(
    (
      await empty.run(["bun", "probe"], async () => {
        launched = true;
        return { passed: true, output: "" };
      })
    ).passed,
  ).toBe(false);
  expect(launched).toBe(false);
});

test("a first-line release-age marker has no preceding command anchor", () => {
  const entry = {
    ...waiver("release-age-exception", "docker-compose.yml"),
    line: 1,
  };
  const contents = `# release-age-quarantine-exception: ${entry.expiresAt}`;
  expect(() =>
    removeWaiver(entry, reader({ [entry.source]: contents })),
  ).toThrow("Release-age exception anchor missing");
});

test("release-age exception removal requires an integral line within its owner", () => {
  const entry = waiver("release-age-exception", "docker-compose.yml");
  const contents = `command: bun install --minimum-release-age 0\n# release-age-quarantine-exception: ${entry.expiresAt}`;
  for (const line of [
    -1,
    0,
    1,
    2.5,
    3,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() =>
      removeWaiver({ ...entry, line }, reader({ [entry.source]: contents })),
    ).toThrow("Release-age exception anchor missing");
  }
  expect(
    removeWaiver(entry, reader({ [entry.source]: contents })).at(0)?.after,
  ).toBe("command: bun install");
});
