import { TaggedError } from "better-result";

import { appLocale, type AppMessageKey } from "./locale";

type AppTranslator = (
  ...args: Parameters<ReturnType<typeof appLocale>["t"]>
) => string;

export type AppMessageDescriptor = {
  key: AppMessageKey;
  values?: Parameters<AppTranslator>[1];
};

export class LocalizedAppError extends TaggedError("LocalizedAppError")<{
  message: string;
  descriptor: AppMessageDescriptor;
}> {
  constructor(descriptor: AppMessageDescriptor) {
    super({
      message: appLocale(undefined).t(descriptor.key, descriptor.values),
      descriptor,
    });
  }
}

export const formatAppError = (
  error: unknown,
  translate: AppTranslator,
  fallback: AppMessageKey,
): string => {
  if (error instanceof LocalizedAppError) {
    return translate(error.descriptor.key, error.descriptor.values);
  }
  return error instanceof Error ? error.message : translate(fallback);
};
