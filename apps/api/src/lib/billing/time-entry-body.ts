import { t } from "elysia";

import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { tSafeId } from "@/api/lib/custom-schema";

export const createTimeEntryBodySchema = t.Object(
  {
    workItemId: t.Optional(
      t.Nullable(
        tSafeId("entity", {
          description:
            "Optional document, folder, or task that provides context for the work",
        }),
      ),
    ),
    dateWorked: t.String({
      format: "date",
      description: "Date the work was done (ISO YYYY-MM-DD)",
    }),
    timezoneId: t.String({
      minLength: 1,
      maxLength: 64,
      description:
        "IANA time zone the dateWorked is interpreted in (e.g. Europe/Prague)",
    }),
    durationMinutes: t.Integer({
      minimum: 1,
      description: "Minutes worked (whole minutes)",
    }),
    narrative: t.String({
      minLength: 0,
      maxLength: 10_000,
      description: "Description of the work",
    }),
    narrativeLanguage: t.Optional(narrativeLanguageSchema),
    billable: t.Optional(
      t.Boolean({ description: "Whether the entry is billable to the client" }),
    ),
    taskCode: t.Optional(
      t.Nullable(
        t.String({
          maxLength: 20,
          description: "UTBMS/LEDES task code; pass null to clear",
        }),
      ),
    ),
    activityCode: t.Optional(
      t.Nullable(
        t.String({
          maxLength: 20,
          description: "UTBMS/LEDES activity code; pass null to clear",
        }),
      ),
    ),
  },
  { additionalProperties: false },
);
