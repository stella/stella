import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-api-env-in-public-reader";
const POLICY = "apps/api/src/public-corpus-policy.ts";
// Reached from the policy through a value import, not listed as an entrypoint.
const LIMITS = "apps/api/src/lib/limits.ts";
// The API entrypoint loads the full environment on purpose.
const SERVER = "apps/api/src/server.ts";

const lint = async (source: string, sourcePath = POLICY) =>
  await lintSingleRule(RULE, source, { sourcePath });

describe.serial(RULE, () => {
  test("a public reader module cannot load the API or worker environment", async () => {
    expect(
      await Promise.all([
        lint('import { env } from "@/api/env";\nexport const value = env;'),
        lint('import { env } from "./env";\nexport const value = env;'),
        lint('export { env } from "@/api/env";'),
        lint('export * from "@/api/env-document-processing-worker";'),
        lint('export const load = () => import("@/api/env");'),
      ]),
    ).toEqual([[1], [1], [1], [1], [1]]);
  });

  test("the boundary follows value imports past the entrypoints", async () => {
    expect(
      await lint(
        'import { env } from "@/api/env";\nexport const value = env;',
        LIMITS,
      ),
    ).toEqual([1]);
  });

  test("type-only imports, narrow env modules and files outside the reader pass", async () => {
    expect(
      await Promise.all([
        lint(
          'import type { env } from "@/api/env";\nexport type Env = typeof env;',
        ),
        lint(
          'import { envPublicCorpus } from "@/api/env-public-corpus";\nexport const value = envPublicCorpus;',
        ),
        lint(
          'import { env } from "@/api/env";\nexport const value = env;',
          SERVER,
        ),
      ]),
    ).toEqual([[], [], []]);
  });
});
