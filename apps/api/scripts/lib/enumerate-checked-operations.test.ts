import { expect, test } from "bun:test";

import { enumerateConditionalOperations } from "./enumerate-checked-operations";

const file = "apps/api/src/handlers/chat/get-suggested-prompts.ts";

for (const specifier of [
  "@/api/lib/api-handlers",
  "@/api/lib/api-handlers.ts",
  "../../lib/api-handlers",
  "../../lib/api-handlers.ts",
  "../../lib/api-handlers/index.ts",
]) {
  for (const binding of [
    {
      declaration: "{ authorizeHandlerUsage as check }",
      call: "check",
      checker: "authorizeHandlerUsage",
    },
    {
      declaration: "* as handlers",
      call: "handlers.authorizeHandlerRunSize",
      checker: "authorizeHandlerRunSize",
    },
  ] as const) {
    test(`${specifier} preserves the ${binding.checker} census`, () => {
      const text = `import ${binding.declaration} from "${specifier}";\n${binding.call}({ metering: { actionType: "chat" } });`;
      expect(enumerateConditionalOperations({ file, text })).toEqual([
        {
          file,
          line: 2,
          checker: binding.checker,
          metering: { actionType: "chat" },
        },
      ]);
    });
  }
}

test("an unrelated module's same-named checker is not an admission operation", () => {
  expect(
    enumerateConditionalOperations({
      file,
      text: 'import { authorizeHandlerUsage } from "./other";\nauthorizeHandlerUsage({ metering: { actionType: "chat" } });',
    }),
  ).toEqual([]);
});

for (const importedName of ["authorizeHandlerUsage", "checkUsage"]) {
  test(`an injected checker defaulting to ${importedName} remains in the admission census`, () => {
    const declaration =
      importedName === "authorizeHandlerUsage"
        ? "authorizeHandlerUsage"
        : `authorizeHandlerUsage as ${importedName}`;
    const text = `import { ${declaration} } from "@/api/lib/api-handlers";
const createHandler = ({ authorizeUsage = ${importedName} } = {}) =>
  authorizeUsage({ metering: { actionType: "doc_review", modelRole: "chat" } });`;
    expect(enumerateConditionalOperations({ file, text })).toEqual([
      {
        file,
        line: 3,
        checker: "authorizeHandlerUsage",
        metering: { actionType: "doc_review", modelRole: "chat" },
      },
    ]);
  });
}
