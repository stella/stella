import { toStandardJsonSchema } from "@valibot/to-json-schema";

import {
  browserControlCommandSchema,
  browserControlResultSchema,
} from "./browser-control";

export const browserControlCommandJsonSchema = toStandardJsonSchema(
  browserControlCommandSchema,
);
export const browserControlResultJsonSchema = toStandardJsonSchema(
  browserControlResultSchema,
);
