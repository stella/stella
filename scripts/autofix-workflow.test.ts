import { describe, expect, test } from "bun:test";

import { GENERATORS, orderGenerators } from "./generated-files";

const WORKFLOW_URL = new URL(
  "../.github/workflows/autofix.yml",
  import.meta.url,
);
const HELPER_URL = new URL("dependabot-changeset.ts", import.meta.url);
const HELPER_TEST_URL = new URL(
  "dependabot-changeset.test.ts",
  import.meta.url,
);
const CHANGESET_GUARD_URL = new URL("changeset-guard.ts", import.meta.url);
const RESOLUTION_SCRIPTS = [
  "scripts/check-resolution-ranges.ts",
  "scripts/check-resolutions-only-change.ts",
  "scripts/fix-resolution-ranges.ts",
  "scripts/json-text-edit.ts",
  "scripts/resolution-ranges.ts",
] as const;
const RESOLUTION_SOURCE_URLS = RESOLUTION_SCRIPTS.map(
  (script) => new URL(script.replace("scripts/", ""), import.meta.url),
);

describe("Dependabot Bun autofix boundary", () => {
  test("keeps the runner read-only and hands off only verified autofixes", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const trustedSourcesStep = workflow.indexOf(
      "- name: Verify trusted autofix sources",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");

    expect(workflow).toContain(
      "name: autofix.ci # autofix.ci uses this exact name as a security boundary",
    );
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("secrets.");

    expect(workflow).toContain("github.actor == 'dependabot[bot]'");
    expect(workflow).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'dependabot/bun/')",
    );
    expect(workflow).toContain(
      `ref: \${{ github.event.pull_request.head.sha }}`,
    );
    expect(workflow).toContain("persist-credentials: false");

    expect(workflow).toContain(
      "bun --no-env-file dedupe --lockfile-only --ignore-scripts",
    );
    expect(workflow).toContain(
      `git diff --name-only "$HEAD_SHA" -- . ':(exclude)bun.lock' ':(exclude)package.json' ":(exclude)$DEPENDABOT_CHANGESET_PATH"`,
    );
    expect(workflow).toContain(
      `git ls-files --others --exclude-standard -- . ":(exclude)$DEPENDABOT_CHANGESET_PATH"`,
    );
    expect(restrictionStep).toBeGreaterThanOrEqual(0);
    expect(trustedSourcesStep).toBeGreaterThanOrEqual(0);
    expect(restrictionStep).toBeGreaterThan(trustedSourcesStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
    expect(workflow).toContain(
      "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a # v1.3.4",
    );
    expect(workflow).toContain("- name: Verify trusted autofix sources");
    expect(workflow).toContain(`git diff --quiet "$BASE_SHA" "$HEAD_SHA" --`);
    expect(workflow).toContain(
      `if [[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]; then`,
    );
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/dependabot-changeset.ts",
    );

    const helperTest = await Bun.file(HELPER_TEST_URL).text();
    const externalTestImports = [...helperTest.matchAll(/from "([^"]+)"/gu)]
      .flatMap((match) => {
        const specifier = match.at(1);
        return specifier === undefined ? [] : [specifier];
      })
      .filter(
        (specifier) =>
          specifier !== "bun:test" &&
          !specifier.startsWith("node:") &&
          !specifier.startsWith("."),
      );
    expect(externalTestImports).toEqual([]);

    const sources = await Promise.all(
      [HELPER_URL, CHANGESET_GUARD_URL, ...RESOLUTION_SOURCE_URLS].map(
        async (url) => await Bun.file(url).text(),
      ),
    );
    // The job never installs, so every script it runs must resolve without
    // node_modules.
    for (const source of sources) {
      expect(source).not.toContain('from "better-result"');
    }
  });

  test("repairs a resolution pin that a bump pushed below its dependents' floor", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const trustedSourcesStep = workflow.indexOf(
      "- name: Verify trusted autofix sources",
    );
    const fixStep = workflow.indexOf(
      "- name: Raise resolutions to their dependents' floors",
    );
    const guardStep = workflow.indexOf("- name: Resolution range guard");
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );

    // The fixer runs only after its own sources are verified against the base,
    // so a Dependabot PR cannot smuggle in a modified fixer.
    for (const script of RESOLUTION_SCRIPTS) {
      expect(workflow.indexOf(script)).toBeGreaterThan(trustedSourcesStep);
      expect(workflow.indexOf(script)).toBeLessThan(fixStep);
    }
    expect(fixStep).toBeGreaterThan(trustedSourcesStep);
    expect(guardStep).toBeGreaterThan(fixStep);
    expect(restrictionStep).toBeGreaterThan(guardStep);

    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/fix-resolution-ranges.ts",
    );
    expect(workflow).toContain("--max-passes 4");
    // The lockfile refresh between passes lives in the fixer, which the
    // trusted-sources step pins to the base revision.
    const fixer = await Bun.file(
      new URL("fix-resolution-ranges.ts", import.meta.url),
    ).text();
    expect(fixer).toContain(`"install", "--lockfile-only", "--ignore-scripts"`);
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/check-resolution-ranges.ts",
    );
    expect(workflow).toContain(
      `bun --no-install --no-env-file scripts/check-resolutions-only-change.ts --ref "$HEAD_SHA"`,
    );
    expect(workflow).toContain("git diff --check -- bun.lock package.json");
  });

  test("adds a deterministic changeset for published dependency updates and verifies it before pushing", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const changesetStep = workflow.indexOf(
      "- name: Add missing Dependabot changeset",
    );
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");
    const writeCall = `bun --no-install --no-env-file scripts/dependabot-changeset.ts
          --base "$BASE_SHA" --head "$HEAD_SHA" --output "$DEPENDABOT_CHANGESET_PATH"`;
    const checkCall = `bun --no-install --no-env-file scripts/dependabot-changeset.ts \\
            --base "$BASE_SHA" --head "$HEAD_SHA" --output "$DEPENDABOT_CHANGESET_PATH" --check`;

    // No workflow-level path filter can drop a package.json-only bump; the
    // Dependabot job scopes itself by head ref.
    expect(workflow).not.toContain("paths:");
    expect(workflow).toContain(
      `DEPENDABOT_CHANGESET_PATH: .changeset/dependabot-dependencies-\${{ github.event.pull_request.number }}.md`,
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain(writeCall);
    expect(workflow).toContain(checkCall);
    expect(workflow).toContain(`":(exclude)$DEPENDABOT_CHANGESET_PATH"`);
    expect(changesetStep).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf(writeCall)).toBeGreaterThan(changesetStep);
    expect(workflow.indexOf(writeCall)).toBeLessThan(restrictionStep);
    expect(workflow.indexOf(checkCall)).toBeGreaterThan(restrictionStep);
    expect(workflow.indexOf(checkCall)).toBeLessThan(pushStep);
    expect(restrictionStep).toBeGreaterThan(changesetStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
  });
});

describe("derived-file regeneration boundary", () => {
  const jobOf = (workflow: string): string => {
    const start = workflow.indexOf("  regenerate-scope:");
    expect(start).toBeGreaterThanOrEqual(0);
    return workflow.slice(start);
  };

  test("regenerates only same-repository pull requests and hands off only generated paths", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());

    expect(job).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(job).toContain(
      "github.event.pull_request.user.login != 'dependabot[bot]'",
    );
    expect(job).toContain(`ref: \${{ github.event.pull_request.head.sha }}`);
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain('NPM_TOKEN: ""');
    expect(job).not.toContain("secrets.");

    const restrictionStep = job.indexOf("- name: Restrict regenerated changes");
    const pushStep = job.indexOf("- name: Push regenerated files");
    expect(restrictionStep).toBeGreaterThanOrEqual(0);
    expect(pushStep).toBeGreaterThan(restrictionStep);
    expect(job.indexOf("autofix-ci/action@")).toBeGreaterThan(pushStep);
  });

  test("runs the manifest plan and keeps the generated diff restricted", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    const ci = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const restrictionStep = job.indexOf("- name: Restrict regenerated changes");
    const fetchStep = job.indexOf("- name: Fetch changed paths");
    const checkoutStep = job.indexOf("- name: Checkout pull request head");
    const planStep = job.indexOf("- name: Match generator inputs");
    const runStep = job.indexOf("- name: Regenerate selected files");
    expect(job).toContain("scripts/autofix-plan.ts plan");
    expect(job).toContain('scripts/autofix-plan.ts run "$GENERATOR_IDS"');
    expect(job).toContain(`allowed: \${{ steps.scope.outputs.allowed }}`);
    expect(job).toContain(
      `GENERATOR_ALLOWED: \${{ needs.regenerate-scope.outputs.allowed }}`,
    );
    expect(job).toContain(
      "IFS='|' read -r -a generated <<< \"$GENERATOR_ALLOWED\"",
    );
    expect(fetchStep).toBeGreaterThanOrEqual(0);
    expect(checkoutStep).toBeGreaterThan(fetchStep);
    expect(planStep).toBeGreaterThan(checkoutStep);
    expect(job.slice(checkoutStep, planStep)).toContain(
      "sparse-checkout-cone-mode: false",
    );
    expect(job.slice(checkoutStep, planStep)).toContain("/scripts/");
    expect(job.slice(checkoutStep, planStep)).toContain("/package.json");
    expect(runStep).toBeGreaterThan(planStep);
    expect(restrictionStep).toBeGreaterThan(runStep);
    expect(job.slice(fetchStep, planStep)).toContain("GH_TOKEN:");
    expect(job.slice(planStep, runStep)).not.toContain("GH_TOKEN:");
    expect(
      job.slice(restrictionStep, job.indexOf("- name: Push regenerated files")),
    ).not.toContain("bun ");
    expect(job).toContain(
      'if [[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]; then',
    );
    expect(job).toContain(`git diff --name-only -- . "\${excludes[@]}"`);
    expect(job).toContain(
      `git ls-files --others --exclude-standard -- . "\${excludes[@]}"`,
    );
    expect(job).not.toContain("inputs='^");
    expect(job).not.toContain("generated=(");
    const ordered = orderGenerators(
      GENERATORS.filter((generator) => generator.autofix),
    );
    expect(
      ordered.findIndex(({ id }) => id === "capability-catalog"),
    ).toBeLessThan(ordered.findIndex(({ id }) => id === "cli-registry"));
    expect(ordered.map(({ id }) => id).toSorted()).toEqual(
      [
        "capability-catalog",
        "cli-registry",
        "mcp-app-bundles",
        "web-api-types",
        "mcp-surface",
        "module-ownership",
        "design-tokens",
        "route-tree",
      ].toSorted(),
    );
    for (const generator of ordered) {
      if (generator.check) {
        expect(ci).toContain("- name: Generated files manifest guard");
        expect(ci).toContain("bun scripts/generated-files-guard.ts --guard-b");
      } else {
        // The null-check families use the named CI guard paired in the manifest.
        expect(generator.checkedBy).toBeDefined();
        expect(ci).toContain(`- name: ${generator.checkedBy ?? ""}`);
      }
    }
  });

  test("each named CI guard runs its generator command or check form", async () => {
    const ci = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    for (const generator of orderGenerators(GENERATORS)) {
      if (!generator.checkedBy) {
        continue;
      }
      const marker = `- name: ${generator.checkedBy}\n`;
      const start = ci.indexOf(marker);
      expect(start, generator.id).toBeGreaterThanOrEqual(0);
      const next = ci.indexOf("\n      - name:", start + marker.length);
      const step = ci.slice(start, next === -1 ? undefined : next);
      const runStart = step.indexOf("\n        run:");
      expect(runStart, generator.id).toBeGreaterThanOrEqual(0);
      const commands = new Set(
        step
          .slice(runStart)
          .split("\n")
          .map((line) => line.trim().replace(/^run: /u, "")),
      );
      const write: readonly string[] = generator.write;
      const check = write.includes("--write")
        ? write.map((part) => (part === "--write" ? "--check" : part))
        : [...write, "--check"];
      const render = (argv: readonly string[]) => {
        const cwd = argv.at(1);
        if (cwd?.startsWith("--cwd=")) {
          return `(cd ${cwd.slice("--cwd=".length)} && bun ${argv.slice(2).join(" ")})`;
        }
        return argv.join(" ");
      };
      expect(
        [write, check].some(
          (argv) => commands.has(argv.join(" ")) || commands.has(render(argv)),
        ),
        `${generator.id}: ${generator.checkedBy}`,
      ).toBe(true);
    }
  });

  test("skips pull requests that touch no generator input", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    expect(job).toContain("needs: regenerate-scope");
    expect(job).toContain("if: needs.regenerate-scope.outputs.run == 'true'");
    expect(job).toContain("scripts/autofix-plan.ts plan");
    expect(job).toContain("scripts/autofix-plan.ts plan --all");
    // A capped file list regenerates rather than skipping.
    expect(job).toContain("-ge 3000");
  });
});
