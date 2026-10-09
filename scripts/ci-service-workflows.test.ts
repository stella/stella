import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import images from "./ci-service-images.json" with { type: "json" };

const root = path.resolve(import.meta.dir, "..");
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected workflow object");
  }
  return Object.fromEntries(Object.entries(value));
};
const readWorkflow = (file: string) =>
  record(Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8")));
const reusableFile = ".github/workflows/ci-service-images.yml";
const reusableSource = readFileSync(path.join(root, reusableFile), "utf-8");

const assertResolverBoundary = (source: string) => {
  const workflow = record(Bun.YAML.parse(source));
  const outputs = record(record(record(workflow.on).workflow_call).outputs);
  const resolver = record(record(workflow.jobs).resolve);
  const resolvedOutputs = record(resolver.outputs);
  const steps = resolver.steps;
  if (!Array.isArray(steps)) {
    throw new TypeError("Expected resolver steps");
  }
  const names = images.map(({ name }) => name).toSorted();
  expect(Object.keys(outputs).toSorted()).toEqual(names);
  expect(Object.keys(resolvedOutputs).toSorted()).toEqual(names);
  for (const name of names) {
    expect(record(outputs[name]).value).toBe(
      `\${{ jobs.resolve.outputs.${name} }}`,
    );
    expect(resolvedOutputs[name]).toBe(`\${{ steps.images.outputs.${name} }}`);
  }
  expect(resolver.permissions).toEqual({ contents: "read", packages: "read" });
  const login = steps.map(record).find(({ id }) => id === "registry");
  expect(login).toHaveProperty(
    "if",
    expect.stringContaining("head.repo.fork != true"),
  );
  expect(login).toHaveProperty(
    "if",
    expect.stringContaining("github.token != ''"),
  );
  expect(login).toHaveProperty("continue-on-error", true);
  expect(login).toHaveProperty("with.password", `\${{ secrets.GITHUB_TOKEN }}`);
  const resolve = steps.map(record).find(({ id }) => id === "images");
  expect(resolve).toHaveProperty(
    "env.CI_IMAGE_MIRROR_ENABLED",
    expect.stringContaining("steps.registry.outcome == 'success'"),
  );
  expect(resolve).toHaveProperty(
    "env.CI_IMAGE_MIRROR_ENABLED",
    expect.stringContaining("head.repo.fork != true"),
  );
  expect(resolve).toHaveProperty(
    "run",
    expect.stringContaining('--resolve >> "$GITHUB_OUTPUT"'),
  );
};

test("CI image resolution exposes exactly the inventory and requires successful authorized registry login", () => {
  assertResolverBoundary(reusableSource);
});

test("CI image resolution guard rejects authentication without the fork boundary", () => {
  const mutation = reusableSource.replaceAll(
    "github.event.pull_request.head.repo.fork != true",
    "true",
  );
  expect(mutation).not.toBe(reusableSource);
  expect(() => assertResolverBoundary(mutation)).toThrow(
    "head.repo.fork != true",
  );
});

const assertWorkflowImages = (jobs: Record<string, unknown>) => {
  for (const [name, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob);
    const serialized = JSON.stringify(job);
    if (serialized.includes("needs.ci-images.outputs.")) {
      const needs = job.needs;
      expect(Array.isArray(needs) ? needs : [needs], name).toContain(
        "ci-images",
      );
    }
    if (
      job.container === undefined &&
      (serialized.includes("run-in-image.sh") ||
        serialized.includes('uses":"./.github/actions/setup-playwright'))
    ) {
      expect(job).toHaveProperty("permissions.packages", "read");
      expect(job).toHaveProperty(
        "env.CI_IMAGE_MIRROR_ENABLED",
        expect.stringContaining("head.repo.fork != true"),
      );
      const steps = job.steps;
      if (!Array.isArray(steps)) {
        throw new TypeError("Expected browser steps");
      }
      const browserIndex = steps.findIndex((step) => {
        const text = JSON.stringify(step);
        return (
          text.includes("run-in-image.sh") ||
          text.includes("./.github/actions/setup-playwright")
        );
      });
      const loginIndex = steps.findIndex(
        (step) =>
          record(step).name ===
          "Login to GitHub Container Registry for browser images",
      );
      const stackIndex = steps.findIndex(
        (step) => record(step).uses === "./.github/actions/setup-e2e-stack",
      );
      expect(loginIndex, name).toBeGreaterThan(stackIndex);
      expect(loginIndex, name).toBeLessThan(browserIndex);
      expect(steps[loginIndex]).toHaveProperty(
        "if",
        expect.stringContaining("head.repo.fork != true"),
      );
      expect(steps[loginIndex]).toHaveProperty(
        "with.password",
        `\${{ secrets.GITHUB_TOKEN }}`,
      );
    }
    const services = job.services === undefined ? {} : record(job.services);
    const containers = Object.values(services);
    if (job.container !== undefined) {
      containers.push(job.container);
    }
    for (const rawContainer of containers) {
      const container = record(rawContainer);
      if (typeof container.image !== "string") {
        throw new TypeError("Expected image reference");
      }
      expect(container.image, name).not.toContain("ghcr.io/stella/ci-mirror/");
      if (
        !container.image.includes("needs.ci-images.outputs.") &&
        !container.image.includes("needs.ci-plan.outputs.playwright_image")
      ) {
        continue;
      }
      expect(job).toHaveProperty("permissions.packages", "read");
      expect(container.credentials).toHaveProperty(
        "username",
        expect.stringContaining("startsWith("),
      );
      expect(container.credentials).toHaveProperty(
        "password",
        expect.stringContaining("secrets.GITHUB_TOKEN"),
      );
      expect(container.credentials).toHaveProperty(
        "password",
        expect.stringContaining("'ghcr.io/'"),
      );
      expect(container.credentials).toHaveProperty(
        "password",
        expect.stringContaining("|| ''"),
      );
    }
  }
};

test("every CI mirror service uses resolved images, required dependencies and registry-specific credentials", () => {
  for (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    const jobs = record(readWorkflow(file).jobs);
    assertWorkflowImages(jobs);
    const callers = Object.values(jobs).map((job) => record(job));
    for (const caller of callers.filter(
      (job) => job.uses === `./${reusableFile}`,
    )) {
      expect(caller).toHaveProperty("permissions.contents", "read");
      expect(caller).toHaveProperty("permissions.packages", "read");
    }
  }
});

test("CI service guard rejects literal private mirror images", () => {
  expect(() =>
    assertWorkflowImages({
      services: {
        services: {
          database: { image: "ghcr.io/stella/ci-mirror/postgres:18" },
        },
      },
    }),
  ).toThrow("ghcr.io/stella/ci-mirror/");
});
