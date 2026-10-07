import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw options custom hooks and aliased form factories", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import { useForm, createFormHook, useForm as aliased } from "@tanstack/react-form";\nimport * as forms from "@tanstack/react-form";\nimport { FormApi } from "@tanstack/form-core";\nconst namespace = forms;\nconst { useForm: destructured } = namespace;\nconst factory = aliased;\nuseForm({ validators: {} });\nuseForm();\nnew FormApi({});\ncreateFormHook({});\naliased({});\nnamespace.useForm({});\ndestructured({});\nfactory({});',
    ),
  ).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
});

test("accepts direct owner options through stable factory and helper aliases", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import * as forms from "@tanstack/react-form";\nimport * as owner from "@/lib/schema";\nconst { useForm: form } = forms;\nconst configure = owner.schemaFormOptions;\nform(configure(config));\nforms["useForm"](owner.schemaFormOptions(config));',
    ),
  ).toEqual([]);
});

test("rejects spread stored unrelated and mutable helper options", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import { useForm } from "@tanstack/react-form";\nimport { schemaFormOptions } from "@/lib/schema";\nimport { schemaFormOptions as unrelated } from "elsewhere";\nconst options = schemaFormOptions(config);\nlet configure = schemaFormOptions;\nuseForm(options);\nuseForm({ ...schemaFormOptions(config) });\nuseForm(unrelated(config));\nuseForm(configure(config));',
    ),
  ).toEqual([6, 7, 8, 9]);
});

test("accepts the exact relative schema owner", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import { useForm } from "@tanstack/react-form";\nimport { schemaFormOptions } from "../lib/schema";\nuseForm(schemaFormOptions(config));',
      { sourcePath: "apps/web/src/components/form.ts" },
    ),
  ).toEqual([]);
});

test("does not trust a same-named schema helper in another directory", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import { useForm } from "@tanstack/react-form";\nimport { schemaFormOptions } from "./schema";\nuseForm(schemaFormOptions(config));',
      { sourcePath: "apps/web/src/components/form.ts" },
    ),
  ).toEqual([3]);
});

test("ignores shadowed local factories and form factories from another module", async () => {
  expect(
    await lintSingleRule(
      "require-schema-form-options",
      'import { useForm } from "@tanstack/react-form";\nimport { schemaFormOptions } from "@/lib/schema";\nimport { useForm as otherForm } from "other-library";\nfunction local(useForm, schemaFormOptions) { useForm(schemaFormOptions({})); useForm({}); }\notherForm({});',
    ),
  ).toEqual([]);
});
