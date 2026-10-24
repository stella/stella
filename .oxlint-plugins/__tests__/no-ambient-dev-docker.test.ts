import { expect, test } from "bun:test";

import config from "../../oxlint.config";
import { readScopes, scopeMatches } from "../../scripts/oxlint-config-scopes";
import { lintSingleRule } from "./lint-single-rule.ts";

test("the production config enables the registered Docker fixture", () => {
  let severity: unknown;
  for (const scope of readScopes(config)) {
    if (
      scopeMatches(
        scope,
        ".oxlint-plugins/__fixtures__/no-ambient-dev-docker.fixture.ts",
      ) &&
      Object.hasOwn(scope.rules, "no-ambient-dev-docker/no-ambient-dev-docker")
    ) {
      severity = scope.rules["no-ambient-dev-docker/no-ambient-dev-docker"];
    }
  }
  expect(severity).toBe("error");
});

test.each([
  'import { $ } from "bun";\nawait $`docker ps`;',
  'import { $ } from "bun";\nawait $`docker`;',
  'import { $ as shell } from "bun";\nawait shell`docker compose down`;',
  'import { $ } from "bun";\nconst run = $; await run`docker ps`;',
  'import * as runtime from "bun";\nawait runtime.$`docker ps`;',
  'import { $ } from "bun";\nconst run = $.cwd("/").env({}); await run`docker ps`;',
  "await Bun.$`/usr/local/bin/docker ps`;",
  'import { $ } from "bun";\nawait $`echo ready && docker ps`;',
  'import { $ } from "bun";\nawait $`echo ready; command docker ps | cat`;',
  'import { $ } from "bun";\nawait $`echo ready\ndocker ps`;',
  'import { $ } from "bun";\nawait $`env DOCKER_HOST=unix:///tmp/other.sock docker ps`;',
  'import { $ } from "bun";\nawait $`sudo -n -u root "/usr/local/bin/docker" ps`;',
  `import { $ } from "bun";\nawait $\`docker ps --filter \${filter}\`;`,
  'import { $ } from "bun";\nawait $`echo ready # comment\ndocker ps`;',
])("Docker Shell commands must use the pinned owner: %s", async (source) => {
  const diagnostics = await lintSingleRule("no-ambient-dev-docker", source, {
    sourcePath: "packages/scripts/src/dev-new-helper.ts",
  });
  expect(diagnostics).toHaveLength(1);
});

test.each([
  'import { $ } from "bun";\nawait $`echo "docker ps"`;',
  'import { $ } from "bun";\nawait $`printf "%s" docker`;',
  'import { $ } from "bun";\nawait $`git status && echo ready`;',
  "const prose = `docker ps`;",
  "sql`docker ps`;",
  "const $ = unrelatedTag; $`docker ps`;",
  "const Bun = unrelatedRuntime; Bun.$`docker ps`;",
  'import { $ } from "unrelated";\nawait $`docker ps`;',
  'import { $ } from "bun";\nconst local = ($) => $`docker ps`;',
])(
  "non-Docker commands and non-shell templates stay clean: %s",
  async (source) => {
    expect(
      await lintSingleRule("no-ambient-dev-docker", source, {
        sourcePath: "packages/scripts/src/dev-new-helper.ts",
      }),
    ).toEqual([]);
  },
);

test("the registered fixture exercises its failing and clean cases", async () => {
  const fixture = await Bun.file(
    new URL(
      "../__fixtures__/no-ambient-dev-docker.fixture.ts",
      import.meta.url,
    ),
  ).text();
  const expected = fixture
    .split("\n")
    .flatMap((line, index) =>
      line.includes("oxlint-disable-next-line no-ambient-dev-docker/")
        ? [index + 2]
        : [],
    );
  expect(
    await lintSingleRule(
      "no-ambient-dev-docker",
      fixture.replaceAll(
        "oxlint-disable-next-line",
        "fixture-expected-diagnostic",
      ),
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/no-ambient-dev-docker.fixture.ts",
      },
    ),
  ).toEqual(expected);
});

test("every development Docker executable reference requires the pinned owner", async () => {
  const source = [
    'Bun.spawnSync(["docker", "ps"]);',
    'resolveCommandPath("docker");',
    'Bun.spawn(["/usr/local/bin/docker", "compose", "down"]);',
    'const executable = "C:\\\\tools\\\\docker.exe";',
    'Bun.spawn([`docker`, "ps"]);',
    'dockerCommand(target, ["ps"]);',
  ].join("\n");
  expect(
    await lintSingleRule("no-ambient-dev-docker", source, {
      sourcePath: "packages/scripts/src/dev-new-helper.ts",
    }),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("endpoint discovery and pinned construction remain at their owner", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-dev-docker",
      'const command = ["docker", "--host", target.host, "ps"];',
      {
        sourcePath: "packages/scripts/src/dev-docker.ts",
      },
    ),
  ).toEqual([]);
});

test("test fixtures and other tools can model Docker commands", async () => {
  const results = await Promise.all(
    ["packages/scripts/src/dev-docker.test.ts", "scripts/ci-images.ts"].map(
      async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lintSingleRule(
            "no-ambient-dev-docker",
            'const command = ["docker", "version"];',
            { sourcePath },
          ),
          expected: [],
        };
      },
    ),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});
