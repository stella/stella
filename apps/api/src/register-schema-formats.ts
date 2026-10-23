import "elysia";
import { FormatRegistry } from "@sinclair/typebox";

import { isApiDate } from "@/api/lib/json-schema/api-date";

// Initialize Elysia first, then replace its rollover-tolerant date parser for
// both HTTP validators and the TypeBox checks used by generated capabilities.
FormatRegistry.Set("date", isApiDate);
