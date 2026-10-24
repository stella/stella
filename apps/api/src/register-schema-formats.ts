import "elysia";
import { FormatRegistry } from "@sinclair/typebox";
import { panic } from "better-result";

import { isApiDate } from "@stll/api-contract/api-date";

import { isStorableInstant } from "@/api/lib/json-schema/api-date";

// Initialize Elysia first, then replace its rollover-tolerant date parser for
// both HTTP validators and the TypeBox checks used by generated capabilities.
FormatRegistry.Set("date", isApiDate);

// Retain Elysia's format check and require a directly parseable API instant
// whose serialized UTC year stays within 0001 to 9999.
const elysiaDateTime =
  FormatRegistry.Get("date-time") ??
  panic("Elysia registers the date-time format on import");
FormatRegistry.Set(
  "date-time",
  (value) => elysiaDateTime(value) && isStorableInstant(value),
);
