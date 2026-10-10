import { expect, test } from "bun:test";
import ts from "typescript";

import {
  removeWaiver,
  runWaiverProbe,
  probeDocUrl,
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

test("test green requires a positive Bun receipt and no remaining skip", async () => {
  for (const [output, expected] of [
    ["0 pass\n0 fail", "red"],
    ["1 pass\n1 skip\n0 fail", "red"],
    ["1 pass\n0 skip\n0 fail", "green"],
  ] as const) {
    const evidence = await runWaiverProbe(
      waiver("quarantined-test", "a.test.ts"),
      { run: async () => ({ passed: true, output }) },
    );
    expect(evidence.status).toBe(expected);
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

test("suppression owner cannot read or write beyond the checkout", () => {
  const entry = {
    ...waiver(
      "suppression-waiver",
      "scripts/suppression-waivers.json",
      "SW-0001",
    ),
    expiresAt: "2026-10-05",
  };
  for (const file of [
    "../secret.ts",
    "/secret.ts",
    "-c",
    "folder\\secret.ts",
  ]) {
    const ledger = JSON.stringify({
      waivers: [
        {
          id: "SW-0001",
          kind: "temporary",
          rule: "require-search-scope/require-search-scope",
          file,
          symbol: "example",
          count: 1,
          reason: "fixture",
          evidence: "example.test.ts",
          expires: "2026-10-05",
        },
      ],
    });
    const reads: string[] = [];
    expect(() =>
      removeWaiver(entry, (source) => {
        reads.push(source);
        return ledger;
      }),
    ).toThrow("file escapes repository");
    expect(reads).toEqual([entry.source]);
  }
});
