import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";

import { APIError } from "@/lib/errors/api";
import { ACTION_ADMISSION_ERROR_KEYS } from "@/lib/errors/localization";
import { sanitizeHref } from "@/lib/sanitize-href";

export const actionAdmissionOutcome = (error: unknown) => {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (APIError.is(current) && isActionAdmissionCode(current.code)) {
      const contact =
        current.code === ACTION_ADMISSION_CODES.periodExhausted ||
        current.code === ACTION_ADMISSION_CODES.notEnabled
          ? current.details?.["contactUrl"]
          : undefined;
      const href =
        typeof contact === "string" ? sanitizeHref(contact) : undefined;
      const contactUrl =
        href &&
        URL.canParse(href) &&
        (new URL(href).protocol === "https:" ||
          new URL(href).protocol === "http:")
          ? href
          : undefined;
      return {
        code: current.code,
        contactUrl,
        messageKey: ACTION_ADMISSION_ERROR_KEYS[current.code],
        retryable: ACTION_ADMISSION_REFUSALS[current.code].retryable,
      };
    }
    current = current.cause;
  }
  return undefined;
};
