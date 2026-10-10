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
const assertResolverBoundary = (job: Record<string, unknown>) => {
  const steps = job["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("Expected resolver steps");
  }
  expect(job).toHaveProperty("permissions.packages", "read");
  const login = steps.map(record).find((step) => step["id"] === "registry");
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
  const resolve = steps.map(record).find((step) => step["id"] === "images");
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

const resolverOutputs = (job: Record<string, unknown>) => {
  const outputs = job["outputs"] === undefined ? {} : record(job["outputs"]);
  return Object.entries(outputs).flatMap(([name, value]) => {
    if (typeof value !== "string") {
      return [];
    }
    const imageName = /^\$\{\{ steps\.images\.outputs\.([\w-]+) \}\}$/u
      .exec(value)
      ?.at(1);
    return imageName === undefined ? [] : [{ name, imageName }];
  });
};

test("planner image outputs bind every consumer to the inventory and authorized resolution", () => {
  let resolverCount = 0;
  for (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    const jobs = record(readWorkflow(file)["jobs"]);
    for (const [id, rawJob] of Object.entries(jobs)) {
      const job = record(rawJob);
      const outputs = resolverOutputs(job);
      if (outputs.length === 0) {
        continue;
      }
      resolverCount += 1;
      assertResolverBoundary(job);
      for (const { name, imageName } of outputs) {
        expect(
          images.map(({ name: inventoryName }) => inventoryName),
        ).toContain(imageName);
        expect(
          Object.values(jobs).some((consumer) =>
            JSON.stringify(consumer).includes(`needs.${id}.outputs.${name}`),
          ),
          `${file}: ${id}.${name}`,
        ).toBe(true);
      }
    }
  }
  expect(resolverCount).toBeGreaterThan(0);
});

test("planner resolution guard rejects authentication without the fork boundary", () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const mutation = source.replaceAll(
    "github.event.pull_request.head.repo.fork != true",
    "true",
  );
  expect(mutation).not.toBe(source);
  const jobs = record(record(Bun.YAML.parse(mutation))["jobs"]);
  const planner = Object.values(jobs)
    .map(record)
    .find((job) => resolverOutputs(job).length > 0);
  if (planner === undefined) {
    throw new TypeError("Expected image planner");
  }
  expect(() => assertResolverBoundary(planner)).toThrow(
    "head.repo.fork != true",
  );
});

const assertWorkflowImages = (jobs: Record<string, unknown>) => {
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob);
    const serialized = JSON.stringify(job);
    for (const reference of serialized.matchAll(
      /needs\.([\w-]+)\.outputs\.([\w-]+)/gu,
    )) {
      const producerName = reference.at(1);
      const outputName = reference.at(2);
      if (
        producerName === undefined ||
        outputName === undefined ||
        jobs[producerName] === undefined
      ) {
        continue;
      }
      const producer = record(jobs[producerName]);
      if (!resolverOutputs(producer).some(({ name }) => name === outputName)) {
        continue;
      }
      const needs = job["needs"];
      expect(Array.isArray(needs) ? needs : [needs], jobName).toContain(
        producerName,
      );
    }
    if (
      job["container"] === undefined &&
      (serialized.includes("run-in-image.sh") ||
        serialized.includes('uses":"./.github/actions/setup-playwright'))
    ) {
      expect(job).toHaveProperty("permissions.packages", "read");
      expect(job).toHaveProperty(
        "env.CI_IMAGE_MIRROR_ENABLED",
        expect.stringContaining("head.repo.fork != true"),
      );
      const steps = job["steps"];
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
          record(step)["name"] ===
          "Login to GitHub Container Registry for browser images",
      );
      const stackIndex = steps.findIndex(
        (step) => record(step)["uses"] === "./.github/actions/setup-e2e-stack",
      );
      expect(loginIndex, jobName).toBeGreaterThan(stackIndex);
      expect(loginIndex, jobName).toBeLessThan(browserIndex);
      expect(steps[loginIndex]).toHaveProperty(
        "if",
        expect.stringContaining("head.repo.fork != true"),
      );
      expect(steps[loginIndex]).toHaveProperty(
        "with.password",
        `\${{ secrets.GITHUB_TOKEN }}`,
      );
    }
    const services =
      job["services"] === undefined ? {} : record(job["services"]);
    const containers = Object.values(services);
    if (job["container"] !== undefined) {
      containers.push(job["container"]);
    }
    for (const rawContainer of containers) {
      const container = record(rawContainer);
      if (typeof container["image"] !== "string") {
        throw new TypeError("Expected image reference");
      }
      expect(container["image"], jobName).not.toContain(
        "ghcr.io/stella/ci-mirror/",
      );
      const reference = /needs\.([\w-]+)\.outputs\.([\w-]+)/u.exec(
        container["image"],
      );
      if (reference === null) {
        continue;
      }
      const producerName = reference.at(1);
      const outputName = reference.at(2);
      if (producerName === undefined || outputName === undefined) {
        throw new TypeError("Expected image output reference");
      }
      const producer = record(jobs[producerName]);
      expect(
        resolverOutputs(producer).map(({ name }) => name),
        jobName,
      ).toContain(outputName);
      const needs = job["needs"];
      expect(Array.isArray(needs) ? needs : [needs], jobName).toContain(
        producerName,
      );
      expect(job).toHaveProperty("permissions.packages", "read");
      expect(typeof container["credentials"]).toBe("string");
      expect(container["credentials"]).toContain(
        `startsWith(needs.${producerName}.outputs.${outputName}, 'ghcr.io/')`,
      );
      expect(container["credentials"]).toContain("secrets.GITHUB_TOKEN");
      expect(container["credentials"]).toContain("fromJSON(format(");
      expect(container["credentials"]).toContain("|| fromJSON('{}')");
    }
  }
};

test("every CI mirror service uses resolved images, required dependencies and registry-specific credentials", () => {
  for (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    const jobs = record(readWorkflow(file)["jobs"]);
    assertWorkflowImages(jobs);
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

test("mirror credentials are cleared before stack application and browser execution, including failures", () => {
  const action = record(
    readWorkflow(".github/actions/setup-e2e-stack/action.yml")["runs"],
  );
  const rawSteps = action["steps"];
  if (!Array.isArray(rawSteps)) {
    throw new TypeError("Expected stack steps");
  }
  const steps = rawSteps.map(record);
  const stack = steps.findIndex((step) => step["id"] === "stack");
  const logout = steps.findIndex(
    (step) => step["run"] === "docker logout ghcr.io",
  );
  const application = steps.findIndex(
    (step) => step["name"] === "Prepare API runtime sources",
  );
  expect(logout).toBeGreaterThan(stack);
  expect(logout).toBeLessThan(application);
  expect(steps[logout]).toHaveProperty("if", "always()");
  const browser = readFileSync(
    path.join(root, ".github/actions/setup-playwright/run-in-image.sh"),
    "utf-8",
  );
  expect(browser).toContain("trap 'docker logout ghcr.io' EXIT");
  expect(browser.indexOf("trap 'docker logout ghcr.io' EXIT")).toBeLessThan(
    browser.indexOf('docker pull "$image"'),
  );
  expect(browser.indexOf('docker pull "$image"')).toBeLessThan(
    browser.indexOf("\ndocker logout ghcr.io\n"),
  );
  expect(browser.indexOf("\ndocker logout ghcr.io\n")).toBeLessThan(
    browser.indexOf("exec docker "),
  );
  expect(browser).toContain("--pull=never");
});

test("staging promotion treats browser mirror authentication as optional", () => {
  const jobs = record(
    readWorkflow(".github/workflows/deploy-staging.yml")["jobs"],
  );
  const job = record(jobs["promote-staging"]);
  const rawSteps = job["steps"];
  if (!Array.isArray(rawSteps)) {
    throw new TypeError("Expected promotion steps");
  }
  const login = rawSteps
    .map(record)
    .find(
      (step) =>
        step["name"] ===
        "Login to GitHub Container Registry for browser images",
    );
  expect(login).toHaveProperty("continue-on-error", true);
});
