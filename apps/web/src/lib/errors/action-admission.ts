import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { APIError } from "@/lib/errors/api";
import { ACTION_ADMISSION_ERROR_KEYS } from "@/lib/errors/localization";

export const actionAdmissionOutcome = (error: unknown) => {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code =
      "code" in current && isActionAdmissionCode(current.code)
        ? current.code
        : undefined;
    if (code !== undefined) {
      let details: unknown;
      if (APIError.is(current)) {
        details = current.details;
      } else if (
        "rawEvent" in current &&
        typeof current.rawEvent === "object" &&
        current.rawEvent !== null &&
        "code" in current.rawEvent &&
        current.rawEvent.code === code
      ) {
        details = current.rawEvent;
      }
      const contact =
        (code === ACTION_ADMISSION_CODES.periodExhausted ||
          code === ACTION_ADMISSION_CODES.notEnabled) &&
        typeof details === "object" &&
        details !== null &&
        "contactUrl" in details
          ? details.contactUrl
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
        code,
        contactUrl,
        messageKey: ACTION_ADMISSION_ERROR_KEYS[code],
        retryable: ACTION_ADMISSION_REFUSALS[code].retryable,
      };
    }
    current = current.cause;
  }
  return undefined;
};
