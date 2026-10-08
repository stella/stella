import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-direct-test-state";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "source.test.ts" });

describe(RULE, () => {
  test("rejects environment assignment, delete, update and replacement", async () => {
    expect(
      await lint(
        'process.env["A"] = "x";\ndelete process.env.A;\nprocess.env.A ??= "x";\nprocess.env.A++;\nprocess.env = {};',
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("follows env/config aliases, namespace imports and dynamic imports", async () => {
    expect(
      await lint(
        'import { env as config } from "@/api/env";\nimport * as api from "@/api/env";\nconst alias = config;\nalias.AI_PROVIDER = "openai";\ndelete api.env.OPENAI_API_KEY;\nconst { env: dynamic } = await import("@/api/env");\ndynamic.USE_MOCK_AI = true;',
      ),
    ).toEqual([4, 5, 7]);
  });

  test("rejects direct and destructured state targets in both loop forms", async () => {
    expect(
      await lint(
        'import { env } from "@/api/env";\nfor (process.env.A of ["changed"]) {}\nfor (env.AI_PROVIDER in { openai: true }) {}\nfor ([process.env.A] of [["changed"]]) {}\nfor ({ a: env.AI_PROVIDER } of [{ a: "openai" }]) {}\nfor ([process.env.A] in { changed: true }) {}\nfor ({ a: env.AI_PROVIDER } in { changed: true }) {}',
      ),
    ).toEqual([2, 3, 4, 5, 6, 7]);
    expect(
      await lint(
        'for (const value of ["changed"]) {}\nfor (const key in { changed: true }) {}',
      ),
    ).toEqual([]);
  });

  test("follows process aliases and destructured env bindings", async () => {
    expect(
      await lint(
        'import proc, { env as imported } from "node:process";\nconst p = process;\nconst { env: variables } = p;\nvariables.A = "x";\nproc.env.A = "x";\nimported.A = "x";\nglobalThis.process["env"].A = "x";',
      ),
    ).toEqual([4, 5, 6, 7]);
  });

  test("follows later assignments and destructured configuration objects", async () => {
    expect(
      await lint(
        'import { env } from "@/api/env";\nconst { API_FEATURE_ACCESS_GRANTS: grants } = env;\ngrants.example = true;\nlet variables;\nvariables = process.env;\nvariables.A = "x";\nconst assign = Object.assign;\nassign(env, {});\nReflect.defineProperty(env, "AI_PROVIDER", { value: "openai" });',
      ),
    ).toEqual([3, 6, 8, 9]);
  });

  test("rejects reflective writes and destructuring assignment targets", async () => {
    expect(
      await lint(
        'import { env } from "@/api/env";\nObject.assign(env, { AI_PROVIDER: "openai" });\nObject.defineProperty(process.env, "A", { value: "x" });\nReflect.set(env, "USE_MOCK_AI", true);\nReflect.deleteProperty(process.env, "A");\n({ value: process.env.A } = input);\n[env.AI_PROVIDER] = input;',
      ),
    ).toEqual([2, 3, 4, 5, 6, 7]);
  });

  test("accepts reads, fixture calls, unrelated objects and shadowed names", async () => {
    expect(
      await lint(
        'import { env } from "@/api/env";\nconst value = process.env.A;\nconst copy = { ...env };\ncopy.AI_PROVIDER = "openai";\nstate.setEnv("A", "x");\nstate.setConfig("AI_PROVIDER", "openai");\nconst local = { env: {} };\nlocal.env.A = "x";\nconst shadowed = (process) => { process.env.A = "x"; };\nconst other = (env) => { env.AI_PROVIDER = "openai"; };',
      ),
    ).toEqual([]);
  });

  test("does not exempt a test just because it shares the owner name", async () => {
    expect(
      await lintSingleRule(RULE, 'process.env.A = "x";', {
        sourcePath: "test-state.test.ts",
      }),
    ).toEqual([1]);
  });

  test("requires serial execution in files using a state fixture", async () => {
    expect(
      await lint(
        'import { test as run } from "bun:test";\nimport { createTestState as fixture } from "@/api/tests/helpers/test-state";\nfixture({ file: import.meta.path, config: {} });\nrun.concurrent("shared state", () => {});',
      ),
    ).toEqual([4]);
    expect(
      await lint(
        'import { test } from "bun:test";\ntest.concurrent("independent", () => {});',
      ),
    ).toEqual([]);
  });

  test("rejects setup registered before the fixture, including aliased hooks", async () => {
    expect(
      await lint(
        'import { beforeEach as setup } from "bun:test";\nimport { createTestState } from "@/api/tests/helpers/test-state";\nsetup(() => state.setEnv("A", "setup"));\nconst state = createTestState({ file: import.meta.path, config: {} });',
      ),
    ).toEqual([3]);
    expect(
      await lint(
        'import { test } from "bun:test";\nimport { createTestState } from "@/api/tests/helpers/test-state";\ntest.each([1])("early", () => {});\nconst state = createTestState({ file: import.meta.path, config: {} });',
      ),
    ).toEqual([3]);
  });

  test("requires file registration scope and fixture-owned beforeAll setup", async () => {
    expect(
      await lint(
        'import { describe } from "bun:test";\nimport { createTestState } from "@/api/tests/helpers/test-state";\ndescribe("nested", () => {\n  createTestState({ file: import.meta.path, config: {} });\n});',
      ),
    ).toEqual([3, 4]);
    expect(
      await lint(
        'import { beforeAll } from "bun:test";\nimport { createTestState } from "@/api/tests/helpers/test-state";\nconst state = createTestState({ file: import.meta.path, config: {} });\nbeforeAll(() => state.setEnv("A", "setup"));',
      ),
    ).toEqual([4]);
    expect(
      await lint(
        'import { beforeEach, afterEach, describe } from "bun:test";\nimport { createTestState } from "@/api/tests/helpers/test-state";\nconst state = createTestState({ file: import.meta.path, config: {} });\nbeforeEach(() => state.setEnv("A", "setup"));\nafterEach(() => state.setEnv("A", "teardown"));\ndescribe("nested", () => { state.beforeAll(() => state.setEnv("A", "file")); });',
      ),
    ).toEqual([]);
  });

  test("the planted file remains rejected with its suppressions removed", async () => {
    const fixture = readFileSync(
      path.join(
        import.meta.dirname,
        "../__fixtures__/no-direct-test-state.fixture.test.ts",
      ),
      "utf-8",
    ).replaceAll(/^\/\/ oxlint-disable-next-line .*\n/gmu, "");
    expect((await lint(fixture)).length).toBe(2);
  });
});
