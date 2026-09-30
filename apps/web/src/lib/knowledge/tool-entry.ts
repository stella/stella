/**
 * `/knowledge/tools/$entry` names either an organization's skill or a tool in
 * the published catalogue. The two never share a name: skill ids are UUIDs,
 * catalogue slugs are lowercase kebab-case and the catalogue refuses a
 * UUID-shaped one.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The catalogue's own slug rule (packages/catalogue schema).
const CATALOGUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type ToolEntryKind = "skill" | "catalogue" | "invalid";

export const classifyToolEntry = (entry: string): ToolEntryKind => {
  // A UUID is tested first: one that starts with a letter would also read as
  // a slug.
  if (UUID_PATTERN.test(entry)) {
    return "skill";
  }
  if (CATALOGUE_SLUG_PATTERN.test(entry)) {
    return "catalogue";
  }
  return "invalid";
};

/** The page an entry opens. */
export type ToolEntryPage<TDetail> =
  | { page: "skill"; skillId: string }
  | { page: "catalogue"; detail: TDetail }
  | { page: "missing" };

/**
 * Resolves an entry to its page. A skill id is handed on untouched and never
 * looked up in the catalogue; only a slug is, and only where the catalogue is
 * served under Knowledge.
 */
export const resolveToolEntry = async <TDetail>(
  entry: string,
  {
    catalogueServed,
    loadCatalogueDetail,
  }: {
    catalogueServed: boolean;
    loadCatalogueDetail: (slug: string) => Promise<TDetail | null>;
  },
): Promise<ToolEntryPage<TDetail>> => {
  const kind = classifyToolEntry(entry);
  if (kind === "skill") {
    return { page: "skill", skillId: entry };
  }
  if (kind === "invalid" || !catalogueServed) {
    return { page: "missing" };
  }
  const detail = await loadCatalogueDetail(entry);
  return detail === null ? { page: "missing" } : { page: "catalogue", detail };
};
