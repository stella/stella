import { revalidateLogic } from "@tanstack/react-form";
import type { FormOptions } from "@tanstack/react-form";
import * as v from "valibot";

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

type NativeSubmit<TSchema extends v.GenericSchema> = NonNullable<
  NativeSchemaFormOptions<TSchema>["onSubmit"]
>;

type NativeSubmitProps<TSchema extends v.GenericSchema> = Parameters<
  NativeSubmit<TSchema>
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
    onSubmit: NativeSubmit<TSchema>;
    submitValues: "raw";
  };

type ParsedSchemaFormOptions<TSchema extends v.GenericSchema> =
  BaseSchemaFormOptions<TSchema> & {
    onSubmit: (
      props: SchemaOutputSubmitProps<TSchema>,
    ) => ReturnType<NativeSubmit<TSchema>>;
    submitValues: "schema-output";
  };

type SchemaFormOptions<TSchema extends v.GenericSchema> =
  | RawSchemaFormOptions<TSchema>
  | ParsedSchemaFormOptions<TSchema>;

export const schemaFormOptions = <const TSchema extends v.GenericSchema>(
  options: SchemaFormOptions<TSchema>,
): NativeSchemaFormOptions<TSchema> => {
  if (options.submitValues === "raw") {
    return {
      defaultValues: options.defaultValues,
      onSubmit: options.onSubmit,
      validationLogic: revalidateLogic(),
      validators: { onDynamic: options.schema },
    };
  }

  return {
    defaultValues: options.defaultValues,
    onSubmit: ({ formApi, meta, value }) =>
      options.onSubmit({
        formApi,
        meta,
        value: v.parse(options.schema, value),
      }),
    validationLogic: revalidateLogic(),
    validators: { onDynamic: options.schema },
  };
};
