import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/autofix.yml", import.meta.url),
  "utf-8",
);
const dependencyJob = workflow.slice(
  workflow.indexOf("  dependabot-bun-autofix:"),
  workflow.indexOf("  regenerate-scope:"),
);
const humanScope = workflow.slice(
  workflow.indexOf("  regenerate-scope:"),
  workflow.indexOf("  regenerate-derived-files:"),
);
const humanJob = workflow.slice(
  workflow.indexOf("  regenerate-derived-files:"),
);
const fixerSources = [
  "scripts/bun-lock-text.ts",
  "scripts/check-tauri-package-alignment.ts",
  "scripts/fix-tauri-package-alignment.ts",
  "scripts/json-text-edit.ts",
];

test("both PR paths use trusted alignment sources before their existing App push", () => {
  for (const job of [dependencyJob, humanJob]) {
    const align = job.indexOf("- name: Align Tauri counterparts");
    const restrict = job.indexOf("- name: Restrict");
    const push = job.indexOf("autofix-ci/action@");
    expect(align).toBeGreaterThan(0);
    expect(restrict).toBeGreaterThan(align);
    expect(push).toBeGreaterThan(restrict);
    expect(job.slice(0, align)).toContain("persist-credentials: false");
    for (const source of fixerSources) {
      expect(job).toContain(source);
    }
    expect(job).toContain('git diff --quiet "$BASE_SHA" "$HEAD_SHA" --');
    expect(job).toContain(
      "bun --no-install --no-env-file scripts/fix-tauri-package-alignment.ts",
    );
    expect(job).toContain(`TAURI_ALLOWED: \${{ steps.tauri.outputs.allowed }}`);
    expect(job).toContain(":(exclude,literal)$path");
    expect(job).toContain(
      "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a",
    );
  }
  expect(dependencyJob).toContain(
    "startsWith(github.event.pull_request.head.ref, 'dependabot/bun/')",
  );
  expect(dependencyJob).toContain(
    "startsWith(github.event.pull_request.head.ref, 'dependabot/cargo/')",
  );
  expect(dependencyJob).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  expect(humanScope).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  expect(humanScope).toContain("github.actor != 'autofix-ci[bot]'");
  expect(humanJob.indexOf("- name: Install dependencies")).toBeGreaterThan(
    humanJob.indexOf("- name: Align Tauri counterparts"),
  );
  expect(workflow).not.toContain("contents: write");
  expect(workflow).not.toContain("pull_request_target:");
});

test("source changes disable human autofix while the independent CI guard remains", () => {
  expect(humanJob).toContain(
    "Alignment fixer sources changed; CI enforces alignment without automatic edits.",
  );
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  );
  const alignment = ci.slice(
    ci.indexOf("- name: Tauri package alignment"),
    ci.indexOf("- name: Tauri counterpart autofix tests"),
  );
  expect(alignment).toContain("bun scripts/check-tauri-package-alignment.ts");
  const autofixTests = ci.slice(
    ci.indexOf("- name: Tauri counterpart autofix tests"),
    ci.indexOf("- name: Lockfile release-age guard"),
  );
  expect(autofixTests).toContain("scripts/fix-tauri-package-alignment.test.ts");
  expect(autofixTests).toContain("scripts/tauri-autofix-workflow.test.ts");
});

test("npm Tauri updates form their own group without changing the existing cadence", () => {
  const config = readFileSync(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf-8",
  );
  const bun = config.slice(config.indexOf('  - package-ecosystem: "bun"'));
  expect(bun).toContain('exclude-patterns:\n          - "@tauri-apps/*"');
  expect(bun).toContain(
    'tauri:\n        patterns:\n          - "@tauri-apps/*"\n        update-types:\n          - "major"\n          - "minor"\n          - "patch"',
  );
  expect(bun).toContain("default-days: 5");
  const schedules = config.match(/^ {4}schedule:\n(?: {6}[^\n]+\n)+/gmu) ?? [];
  const ecosystems = config.match(/^ {2}- package-ecosystem:/gmu) ?? [];
  expect(schedules).toHaveLength(ecosystems.length);
  expect(schedules.length).toBeGreaterThan(0);
  for (const schedule of schedules) {
    expect(schedule).toBe(
      '    schedule:\n      interval: "weekly"\n      day: "monday"\n      time: "03:00"\n      timezone: "Europe/Prague"\n',
    );
  }
});
