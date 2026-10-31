import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { PUBLIC_LAW_PAGE_SIZES } from "@stll/api-contract/limits";

export type PublicLawPageSize = (typeof PUBLIC_LAW_PAGE_SIZES)[number];

export const DEFAULT_PUBLIC_LAW_PAGE_SIZE = 50 satisfies PublicLawPageSize;
export const PUBLIC_LAW_MAX_PAGE = 40;

const isPublicLawPageSize = (value: number): value is PublicLawPageSize =>
  PUBLIC_LAW_PAGE_SIZES.some((size) => size === value);

export const publicLawPageSize = (
  value: number | undefined,
): PublicLawPageSize =>
  value !== undefined && isPublicLawPageSize(value)
    ? value
    : DEFAULT_PUBLIC_LAW_PAGE_SIZE;

export const publicLawPageNumber = (
  value: number | undefined,
  deepestPage = PUBLIC_LAW_MAX_PAGE,
): number =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= deepestPage
    ? value
    : 1;

export const publicLawPageSearchValue = (page: number): number | undefined =>
  page <= 1 ? undefined : page;

export const publicLawPageSizeSearchValue = (
  pageSize: PublicLawPageSize,
): PublicLawPageSize | undefined =>
  pageSize === DEFAULT_PUBLIC_LAW_PAGE_SIZE ? undefined : pageSize;

export const publicLawPageSearchSchemaUpTo = (deepestPage: number) =>
  v.fallback(
    v.optional(
      v.pipe(
        v.union([v.number(), v.string()]),
        v.transform((value) =>
          publicLawPageNumber(
            typeof value === "number"
              ? value
              : parseIntegerToken(value, { sign: "unsigned" }).unwrapOr(
                  undefined,
                ),
            deepestPage,
          ),
        ),
        v.transform((page) => publicLawPageSearchValue(page)),
      ),
    ),
    undefined,
  );

export const publicLawPageSearchSchema =
  publicLawPageSearchSchemaUpTo(PUBLIC_LAW_MAX_PAGE);

export const publicLawPageSizeSearchSchema = v.fallback(
  v.optional(
    v.pipe(
      v.union([v.number(), v.string()]),
      v.transform((value) =>
        publicLawPageSize(
          typeof value === "number"
            ? value
            : parseIntegerToken(value, { sign: "unsigned" }).unwrapOr(
                undefined,
              ),
        ),
      ),
      v.transform((pageSize) => publicLawPageSizeSearchValue(pageSize)),
    ),
  ),
  undefined,
);
