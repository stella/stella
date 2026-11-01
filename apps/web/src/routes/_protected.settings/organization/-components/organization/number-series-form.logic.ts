import * as v from "valibot";

import type {
  NumberSeries,
  NumberSeriesInput,
} from "@/lib/organization/number-series";
import { toSafeId } from "@/lib/safe-id";

export const NUMBER_SERIES_PADDING_OPTIONS = [1, 2, 3, 4, 5, 6] as const;
export const DEFAULT_NUMBER_SERIES_PATTERN = "{YYYY}-{SEQ}";

type NumberSeriesValidationMessages = {
  required: string;
  invalidField: string;
};
export const numberSeriesFormSchema = ({
  required,
  invalidField,
}: NumberSeriesValidationMessages) =>
  v.pipe(
    v.object({
      name: v.pipe(
        v.string(),
        v.trim(),
        v.nonEmpty(required),
        v.maxLength(128, invalidField),
      ),
      documentType: v.picklist(
        ["invoice", "advance", "credit_note"],
        invalidField,
      ),
      pattern: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(5, invalidField),
        v.maxLength(128, invalidField),
      ),
      padding: v.pipe(
        v.number(),
        v.integer(invalidField),
        v.minValue(1, invalidField),
        v.maxValue(6, invalidField),
      ),
      sellerProfileId: v.pipe(
        v.nullable(v.string()),
        v.transform((value) =>
          value === null || value.trim() === ""
            ? undefined
            : toSafeId<"sellerProfile">(value.trim()),
        ),
      ),
    }),
    v.transform(
      ({ sellerProfileId, ...value }) =>
        ({
          ...value,
          ...(sellerProfileId === undefined ? {} : { sellerProfileId }),
        }) satisfies NumberSeriesInput,
    ),
  );

type NumberSeriesPatchOptions = {
  original: NumberSeries;
  next: NumberSeriesInput;
};
export const numberSeriesPatch = ({
  original,
  next,
}: NumberSeriesPatchOptions) => ({
  ...(original.name === next.name ? {} : { name: next.name }),
  ...(original.pattern === next.pattern ? {} : { pattern: next.pattern }),
  ...(original.padding === next.padding ? {} : { padding: next.padding }),
  ...(original.sellerProfileId === (next.sellerProfileId ?? null)
    ? {}
    : { sellerProfileId: next.sellerProfileId ?? null }),
});
