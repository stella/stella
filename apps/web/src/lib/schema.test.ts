import { FieldApi, FormApi } from "@tanstack/react-form";
import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import {
  emailSchema,
  optionalUuidSearchSchema,
  schemaFormOptions,
} from "@/lib/schema";

describe("optional UUID search filters", () => {
  const uuid = "0194d94a-1122-7000-8000-123456789abc";

  test("preserves full UUIDs in either hex case and absent filters", () => {
    for (const value of [uuid, uuid.toUpperCase(), undefined]) {
      expect(v.parse(optionalUuidSearchSchema, value)).toBe(value);
    }
  });

  test("drops malformed public URL identifiers instead of sending them to the API", () => {
    for (const value of [
      "not-a-uuid",
      "",
      `${uuid}\n`,
      ` ${uuid}`,
      `${uuid} `,
      uuid.replaceAll("-", ""),
      uuid.replace("a", "g"),
      42,
      null,
      [uuid],
    ]) {
      expect(v.parse(optionalUuidSearchSchema, value)).toBeUndefined();
    }
  });
});

const INVALID_EMAIL = "not an email";
const VALID_EMAIL = "  User@Example.COM  ";
const PASSWORD = "  keep password whitespace  ";
const QUANTITY = " 42 ";

const credentialsSchema = v.object({
  email: emailSchema(),
  password: v.string(),
  quantity: v.pipe(
    v.string(),
    v.trim(),
    v.regex(/^\d+$/u, "Quantity must be numeric"),
    v.toNumber(),
  ),
});

const defaultValues = {
  email: INVALID_EMAIL,
  password: PASSWORD,
  quantity: QUANTITY,
};

type CredentialsOptions = Parameters<
  typeof schemaFormOptions<typeof credentialsSchema>
>[0];

type OptionsWithoutSubmissionMode = {
  defaultValues: v.InferInput<typeof credentialsSchema>;
  onSubmit: () => void;
  schema: typeof credentialsSchema;
};

describe("schema-backed form options", () => {
  test("requires an explicit raw or schema-output submission choice", () => {
    expectTypeOf<CredentialsOptions["submitValues"]>().toEqualTypeOf<
      "raw" | "schema-output"
    >();
    expectTypeOf<OptionsWithoutSubmissionMode>().not.toExtend<CredentialsOptions>();
  });

  test("blocks invalid raw submissions and later submits original input", async () => {
    let submittedValues: v.InferInput<typeof credentialsSchema> | undefined;
    const form = new FormApi(
      schemaFormOptions({
        defaultValues,
        onSubmit: ({ formApi, value }) => {
          expectTypeOf(value).toEqualTypeOf<
            v.InferInput<typeof credentialsSchema>
          >();
          expectTypeOf(formApi.state.values).toEqualTypeOf<
            v.InferInput<typeof credentialsSchema>
          >();
          submittedValues = value;
        },
        schema: credentialsSchema,
        submitValues: "raw",
      }),
    );
    const field = new FieldApi({ form, name: "email" });
    const unmountForm = form.mount();
    const unmountField = field.mount();

    try {
      await form.handleSubmit();

      expect(submittedValues).toBeUndefined();
      expect(field.state.meta.errors).toEqual([
        expect.objectContaining({ message: expect.any(String) }),
      ]);

      field.handleChange(VALID_EMAIL);

      expect(field.state.meta.errors).toEqual([]);
      await form.handleSubmit();
      expect(submittedValues).toEqual({
        email: VALID_EMAIL,
        password: PASSWORD,
        quantity: QUANTITY,
      });
    } finally {
      unmountField();
      unmountForm();
    }
  });

  test("blocks invalid parsed submissions and later submits schema output", async () => {
    let submittedValues: v.InferOutput<typeof credentialsSchema> | undefined;
    const form = new FormApi(
      schemaFormOptions({
        defaultValues,
        onSubmit: ({ formApi, value }) => {
          expectTypeOf(value).toEqualTypeOf<
            v.InferOutput<typeof credentialsSchema>
          >();
          expectTypeOf(formApi.state.values).toEqualTypeOf<
            v.InferInput<typeof credentialsSchema>
          >();
          formApi.setErrorMap({
            onSubmit: { fields: { email: "Server rejected email" } },
          });
          formApi.reset({
            email: "reset@example.com",
            password: "reset password",
            quantity: "7",
          });
          submittedValues = value;
        },
        schema: credentialsSchema,
        submitValues: "schema-output",
      }),
    );
    const field = new FieldApi({ form, name: "email" });
    const unmountForm = form.mount();
    const unmountField = field.mount();

    try {
      await form.handleSubmit();

      expect(submittedValues).toBeUndefined();
      expect(field.state.meta.errors).toEqual([
        expect.objectContaining({ message: expect.any(String) }),
      ]);

      field.handleChange(VALID_EMAIL);

      expect(field.state.meta.errors).toEqual([]);
      await form.handleSubmit();
      expect(submittedValues).toEqual({
        email: "user@example.com",
        password: PASSWORD,
        quantity: 42,
      });
      expect(form.state.values).toEqual({
        email: "reset@example.com",
        password: "reset password",
        quantity: "7",
      });
    } finally {
      unmountField();
      unmountForm();
    }
  });
});
