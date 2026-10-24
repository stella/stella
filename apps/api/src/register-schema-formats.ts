import "elysia";
import { FormatRegistry } from "@sinclair/typebox";
import { panic } from "better-result";

import { isApiDate } from "@stll/api-contract/api-date";

import { isStorableInstant } from "@/api/lib/json-schema/api-date";

// Initialize Elysia first, then replace its rollover-tolerant date parser for
// both HTTP validators and the TypeBox checks used by generated capabilities.
FormatRegistry.Set("date", isApiDate);

// Elysia's date-time check decides the accepted spellings; the range check
// only drops instants outside the API serialized UTC year range.
const elysiaDateTime =
  FormatRegistry.Get("date-time") ??
  panic("Elysia registers the date-time format on import");
FormatRegistry.Set(
  "date-time",
  (value) => elysiaDateTime(value) && isStorableInstant(value),
);
