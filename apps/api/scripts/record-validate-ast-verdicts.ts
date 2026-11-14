import { mock } from "bun:test";

await mock.module("@/api/lib/observability/logger", () => ({
  logger: {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    }),
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

const [{ buildValidateAstInputs }, { validateAst }] = await Promise.all([
  import("@/api/tests/helpers/validate-ast-inputs"),
  import("@/api/lib/legal-search/parsers/validate-ast"),
]);
const verdicts = [];
for (const input of await buildValidateAstInputs()) {
  verdicts.push({
    name: input.name,
    result: validateAst(input.source, input.blocks),
  });
}
const output = new URL(
  "../src/lib/legal-search/parsers/validate-ast-verdicts.golden.json",
  import.meta.url,
);
await Bun.write(output, `${JSON.stringify(verdicts, undefined, 2)}\n`);
console.log(`wrote ${verdicts.length} verdicts to ${output.pathname}`);
