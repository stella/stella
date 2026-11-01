import { load } from "@stll/html";

import type {
  SourceFieldDisposition,
  SourceFieldInventory,
} from "@/api/lib/legal-search/ingestion-types";
import type { SourceRawParts } from "@/api/lib/legal-search/source-raw-envelope";

/**
 * Soft-law publishers expose listings only: no count endpoint and no
 * exhaustive date-slice interface. `reason` states why for this publisher.
 */
export const listingOnlyCoverage = (reason: string) => ({
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: { type: "unsupported" as const, reason },
});

type SelectorSourceFieldsOptions<Field extends string> = {
  fields: Readonly<Record<Field, SourceFieldDisposition>>;
  selectors: Readonly<Record<Field, string>>;
  /** The stored HTML part the selectors read. */
  part: string;
};

/** Declares a source's fields as those whose selector matches a stored page. */
export const selectorSourceFields = <Field extends string>({
  fields,
  selectors,
  part,
}: SelectorSourceFieldsOptions<Field>) =>
  ({
    status: "declared",
    fields,
    listSourceFields: (parts: SourceRawParts) => {
      const $ = load(parts[part] ?? "");
      return Object.entries(selectors).flatMap(([field, selector]) =>
        typeof selector === "string" && $(selector).length > 0 ? [field] : [],
      );
    },
  }) satisfies SourceFieldInventory;
