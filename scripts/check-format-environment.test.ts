import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import formatterConfig from "../.oxfmtrc.json" with { type: "json" };
import rootPackage from "../package.json" with { type: "json" };
import { workflowSchema } from "./check-ci-event-policy";

const referencedPackages = (value: unknown): string[] => {
  if (typeof value === "string") {
    const name = /^\.?\/?node_modules\/((?:@[^/]+\/)?[^/]+)\//u
      .exec(value)
      ?.at(1);
    return name === undefined ? [] : [name];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap(referencedPackages);
};

const assertFormatterDependencies = (config: unknown) => {
  const packages = new Set(referencedPackages(config));
  const dependencies = new Set(Object.keys(rootPackage.devDependencies));
  expect(packages.size).toBeGreaterThan(0);
  for (const name of packages) {
    expect(dependencies.has(name), name).toBe(true);
  }
};

test("formatter package resources belong to root dependencies for scoped installs", () => {
  assertFormatterDependencies(formatterConfig);
});

test("formatter dependency census rejects undeclared package resources", () => {
  const name = "formatter-census-undeclared";
  expect(Object.hasOwn(rootPackage.devDependencies, name)).toBe(false);
  expect(() =>
    assertFormatterDependencies({
      nested: [{ stylesheet: `node_modules/${name}/theme.css` }],
    }),
  ).toThrow(name);
});

test("scan engine installs the formatter owner alongside its workspace", () => {
  const workflow = v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  const install = workflow.jobs["scan-engine-wasm-drift"]?.steps?.find(
    (step) => step["name"] === "Install dependencies",
  );
  expect(install?.["run"]).toContain(`--filter ${rootPackage.name}`);
});
