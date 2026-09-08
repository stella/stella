import { FieldApi, FormApi, revalidateLogic } from "@tanstack/react-form";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

const REQUIRED_MESSAGE = "Name is required";
const INVALID_NAME = "   ";
const VALID_NAME = "  Ada Lovelace  ";

const nameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, REQUIRED_MESSAGE),
);
const formSchema = v.object({ name: nameSchema });
const asyncNameSchema = v.pipeAsync(
  v.string(),
  v.trim(),
  v.checkAsync((name) => Promise.resolve(name.length > 0), REQUIRED_MESSAGE),
);
const asyncFormSchema = v.objectAsync({ name: asyncNameSchema });

const validationCases = [
  { name: "form-level onDynamic", validator: "form-sync" },
  { name: "form-level onDynamicAsync", validator: "form-async" },
  { name: "field-level onDynamic", validator: "field-sync" },
  { name: "field-level onDynamicAsync", validator: "field-async" },
] as const;

type ValidatorCase = (typeof validationCases)[number]["validator"];
type ValidationLogic = "default" | "revalidate";

const createHarness = (
  validator: ValidatorCase,
  validationLogic: ValidationLogic,
) => {
  const submittedValues: Array<{ name: string }> = [];
  const form = new FormApi({
    defaultValues: { name: INVALID_NAME },
    onSubmit: ({ value }) => {
      submittedValues.push(value);
    },
    validationLogic:
      validationLogic === "revalidate" ? revalidateLogic() : undefined,
    validators: {
      onDynamic: validator === "form-sync" ? formSchema : undefined,
      onDynamicAsync: validator === "form-async" ? asyncFormSchema : undefined,
    },
  });
  const field = new FieldApi({
    form,
    name: "name",
    validators: {
      onDynamic: validator === "field-sync" ? nameSchema : undefined,
      onDynamicAsync: validator === "field-async" ? asyncNameSchema : undefined,
    },
  });
  const unmountForm = form.mount();
  const unmountField = field.mount();

  const changeName = async (name: string) => {
    field.handleChange(name);
    if (!form.state.isFormValidating && !field.state.meta.isValidating) {
      return;
    }

    await new Promise<void>((resolve) => {
      const subscriptions: Array<{ unsubscribe: () => void }> = [];
      const resolveWhenSettled = () => {
        if (form.state.isFormValidating || field.state.meta.isValidating) {
          return;
        }

        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }
        resolve();
      };

      subscriptions.push(form.store.subscribe(resolveWhenSettled));
      subscriptions.push(field.store.subscribe(resolveWhenSettled));
      resolveWhenSettled();
    });
  };

  return {
    changeName,
    cleanup: () => {
      unmountField();
      unmountForm();
    },
    fieldErrors: () => field.state.meta.errors,
    formErrors: () => form.state.errors,
    submit: () => form.handleSubmit(),
    submittedValues,
  };
};

describe("TanStack Form dynamic validation", () => {
  for (const validationCase of validationCases) {
    test(`${validationCase.name} requires revalidateLogic`, async () => {
      const omittedLogic = createHarness(validationCase.validator, "default");
      try {
        await omittedLogic.submit();

        expect(omittedLogic.submittedValues).toEqual([{ name: INVALID_NAME }]);
        expect(omittedLogic.formErrors()).toEqual([]);
        expect(omittedLogic.fieldErrors()).toEqual([]);
      } finally {
        omittedLogic.cleanup();
      }

      const revalidation = createHarness(
        validationCase.validator,
        "revalidate",
      );
      try {
        await revalidation.submit();

        expect(revalidation.submittedValues).toEqual([]);
        expect(revalidation.fieldErrors()).toEqual([
          expect.objectContaining({ message: REQUIRED_MESSAGE }),
        ]);

        await revalidation.changeName(VALID_NAME);

        expect(revalidation.fieldErrors()).toEqual([]);
        await revalidation.submit();
        expect(revalidation.submittedValues).toEqual([{ name: VALID_NAME }]);
      } finally {
        revalidation.cleanup();
      }
    });
  }
});
