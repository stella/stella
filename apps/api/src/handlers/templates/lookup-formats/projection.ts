import type { templateLookupFormats } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

export const FORMAT_LIMITS = {
  name: 120,
  format: 2000,
  pageDefault: 50,
  pageMax: 100,
} as const;

export const toResponse = ({
  id,
  registry,
  name,
  format,
  createdAt,
}: typeof templateLookupFormats.$inferSelect) => ({
  id,
  registry,
  name,
  format,
  createdAt: createdAt.toISOString(),
});

type LookupFormatRow = typeof templateLookupFormats.$inferSelect;
const UNPROJECTED_LOOKUP_FORMAT_COLUMNS = [
  // Tenant scope comes from the active organization, never the response.
  "organizationId",
  // The list exposes this through its separate defaultFormat member.
  "preference",
] as const satisfies readonly (keyof LookupFormatRow)[];

type MissingProjectedLookupFormatColumn = UnprojectedColumns<
  LookupFormatRow,
  ReturnType<typeof toResponse>,
  (typeof UNPROJECTED_LOOKUP_FORMAT_COLUMNS)[number]
>;
type UnexpectedProjectedLookupFormatColumn = UnbackedProjectionKeys<
  LookupFormatRow,
  ReturnType<typeof toResponse>,
  (typeof UNPROJECTED_LOOKUP_FORMAT_COLUMNS)[number]
>;

true satisfies MissingProjectedLookupFormatColumn extends never ? true : never;
true satisfies UnexpectedProjectedLookupFormatColumn extends never
  ? true
  : never;
