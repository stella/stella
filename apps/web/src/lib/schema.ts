import { revalidateLogic } from "@tanstack/react-form";
import type { AnyFieldMeta, FormOptions } from "@tanstack/react-form";
import * as v from "valibot";

type FormErrors = Record<string, string | string[]>;

const toUndefinedIfEmpty = (value: string) =>
  value.length > 0 ? value : undefined;

export const trimmedStringSchema = () => v.pipe(v.string(), v.trim());

export const requiredTrimmedStringSchema = (message: string) =>
  v.pipe(v.string(), v.trim(), v.nonEmpty(message));

export const emailSchema = () =>
  v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email());

export const optionalSearchStringSchema = () =>
  v.optional(v.pipe(v.string(), v.trim(), v.transform(toUndefinedIfEmpty)));

const fieldErrorsToString = (errors: readonly unknown[]): string | null => {
  if (errors.length === 0) {
    return null;
  }

  return errors
    .map((error) => {
      if (typeof error === "string") {
        return error;
      }

      if (typeof error === "object" && error && "message" in error) {
        return error.message;
      }

      return "Unknown error";
    })
    .join(", ");
};

export const toFormErrors = (
  errors: Partial<Record<string, AnyFieldMeta>>,
): FormErrors | undefined => {
  const errorsMap = new Map<string, string>();

  for (const [key, value] of Object.entries(errors)) {
    if (!value) {
      continue;
    }

    const errorsString = fieldErrorsToString(value.errors);

    if (errorsString) {
      errorsMap.set(key, errorsString);
    }
  }

  if (errorsMap.size === 0) {
    return undefined;
  }

  return Object.fromEntries(errorsMap);
};

type NativeSchemaFormOptions<TSchema extends v.GenericSchema> = FormOptions<
  v.InferInput<TSchema>,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  TSchema,
  undefined,
  undefined
>;

type NativeSubmitProps<TSchema extends v.GenericSchema> = Parameters<
  NonNullable<NativeSchemaFormOptions<TSchema>["onSubmit"]>
>[0];

type SchemaOutputSubmitProps<TSchema extends v.GenericSchema> = Omit<
  NativeSubmitProps<TSchema>,
  "value"
> & {
  value: v.InferOutput<TSchema>;
};

type BaseSchemaFormOptions<TSchema extends v.GenericSchema> = {
  defaultValues: v.InferInput<TSchema>;
  schema: TSchema;
};

type RawSchemaFormOptions<TSchema extends v.GenericSchema> =
  BaseSchemaFormOptions<TSchema> & {
    onSubmit: (props: NativeSubmitProps<TSchema>) => void | Promise<void>;
    submitValues: "raw";
  };

type ParsedSchemaFormOptions<TSchema extends v.GenericSchema> =
  BaseSchemaFormOptions<TSchema> & {
    onSubmit: (props: SchemaOutputSubmitProps<TSchema>) => void | Promise<void>;
    submitValues: "schema-output";
  };

type SchemaFormOptions<TSchema extends v.GenericSchema> =
  | RawSchemaFormOptions<TSchema>
  | ParsedSchemaFormOptions<TSchema>;

export const schemaFormOptions = <const TSchema extends v.GenericSchema>(
  options: SchemaFormOptions<TSchema>,
) => {
  const onSubmit = async (props: NativeSubmitProps<TSchema>) => {
    if (options.submitValues === "raw") {
      await options.onSubmit(props);
      return;
    }

    await options.onSubmit({
      ...props,
      value: v.parse(options.schema, props.value),
    });
  };

  return {
    defaultValues: options.defaultValues,
    onSubmit,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: options.schema },
  };
};
