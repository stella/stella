import type { AnyFieldMeta } from "@tanstack/react-form";
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
