import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";

export const STATUS_ERROR_KEYS = {
  badRequest: "errors.api.badRequest",
  conflict: "errors.api.conflict",
  forbidden: "errors.api.forbidden",
  notFound: "errors.api.notFound",
  payloadTooLarge: "errors.api.payloadTooLarge",
  rateLimited: "errors.api.rateLimited",
  server: "errors.api.server",
  serviceUnavailable: "errors.api.serviceUnavailable",
  unauthorized: "errors.api.unauthorized",
  unknown: "errors.api.unknown",
  validation: "errors.api.validation",
} as const satisfies Record<string, TranslationKey>;

export const STATUS_TO_KEY: Readonly<
  Record<number, TranslationKey | undefined>
> = {
  400: STATUS_ERROR_KEYS.badRequest,
  401: STATUS_ERROR_KEYS.unauthorized,
  403: STATUS_ERROR_KEYS.forbidden,
  404: STATUS_ERROR_KEYS.notFound,
  409: STATUS_ERROR_KEYS.conflict,
  413: STATUS_ERROR_KEYS.payloadTooLarge,
  422: STATUS_ERROR_KEYS.validation,
  429: STATUS_ERROR_KEYS.rateLimited,
  500: STATUS_ERROR_KEYS.server,
  502: STATUS_ERROR_KEYS.serviceUnavailable,
};

export const translateError = (key: TranslationKey): string =>
  getTranslator()(key);
