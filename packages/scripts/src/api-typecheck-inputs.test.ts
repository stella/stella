import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  apiProgramTypecheckInputs,
  uncoveredApiTypecheckFiles,
} from "./api-typecheck-inputs";
import { apiTypecheckInputIssues } from "./api-typecheck-partition";

test("workspace covering inputs stay stable as files move and imports change within a root", async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "api-covering-inputs-")),
  );
  const api = path.join(root, "apps/api");
  const project = path.join(api, "tsconfig.src.json");
  const source = path.join(api, "src/value.ts");
  const shared = path.join(root, "packages/shared/src/value.ts");
  try {
    mkdirSync(api, { recursive: true });
    writeFileSync(
      project,
      JSON.stringify({
        files: [],
        include: ["src/**/*.ts"],
        compilerOptions: { types: [] },
      }),
    );
    writeFileSync(
      path.join(api, "package.json"),
      JSON.stringify({
        scripts: { "typecheck:src": "bun check --project=tsconfig.src.json" },
      }),
    );
    const inputs = await apiProgramTypecheckInputs(project, [source, shared]);
    const added = [
      path.join(api, "src/new.test.ts"),
      path.join(api, "src/handlers/visual-sandbox/browser/value.ts"),
      path.join(api, "src/inventory.json"),
      path.join(root, "packages/shared/tests/new.test.ts"),
    ];
    expect(
      await apiProgramTypecheckInputs(project, [source, shared, ...added]),
    ).toEqual(inputs);
    expect(
      await apiProgramTypecheckInputs(project, [
        source,
        path.join(root, "packages/shared/moved.ts"),
      ]),
    ).toEqual(inputs);
    expect(
      uncoveredApiTypecheckFiles({
        files: [source, shared, ...added],
        inputs,
        project,
      }),
    ).toEqual([]);
    const other = path.join(root, "packages/other/src/value.ts");
    expect(
      uncoveredApiTypecheckFiles({ files: [other], inputs, project }),
    ).toEqual([other]);
    expect(
      await apiProgramTypecheckInputs(project, [source, shared, other]),
    ).toContain("$TURBO_ROOT$/packages/other/**");
    const programs = new Map([
      ["@stll/api#typecheck:src", [source, shared, ...added]],
    ]);
    const writeInputs = (values: string[]) =>
      writeFileSync(
        path.join(root, "turbo.json"),
        JSON.stringify({
          tasks: { "@stll/api#typecheck:src": { inputs: values } },
        }),
      );
    writeInputs([...inputs, "extra/**"]);
    expect(await apiTypecheckInputIssues(root, programs)).toEqual([]);
    for (const excluded of [
      "!src/**/*.test.ts",
      "!src/not-yet-created/**",
      "!src/handlers/visual-sandbox/browser/**",
      "!$TURBO_ROOT$/packages/shared/**",
      "!$TURBO_ROOT$/.npmrc",
    ]) {
      writeInputs([...inputs, excluded]);
      expect(await apiTypecheckInputIssues(root, programs)).toHaveLength(1);
    }
    writeInputs(inputs.filter((input) => input !== "**"));
    expect(
      await apiTypecheckInputIssues(
        root,
        new Map([["@stll/api#typecheck:src", []]]),
      ),
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
