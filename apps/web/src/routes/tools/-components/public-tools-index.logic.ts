import {
  filterToolEntries,
  type ToolFilterEntry,
  type ToolFilters,
} from "@/lib/tools-catalogue";

export const PUBLIC_TOOL_TASKS = [
  "review-agreements",
  "research-precedents",
  "verify-organizations",
  "protect-client-data",
  "prepare-documents",
] as const;

export type PublicToolTask = (typeof PUBLIC_TOOL_TASKS)[number];

const TASK_SLUGS = {
  "prepare-documents": ["create-docx"],
  "protect-client-data": ["anonymize"],
  "research-precedents": [
    "jurisrank-csjn-analysis",
    "infosoud",
    "boe",
    "web-search",
  ],
  "review-agreements": ["contract-review"],
  "verify-organizations": [
    "ares",
    "brreg",
    "companies-house",
    "denue",
    "edgar",
    "gcis",
    "krs",
    "orsr",
    "prh",
    "recherche-entreprises",
    "vies",
  ],
} as const satisfies Record<PublicToolTask, readonly string[]>;

export type PublicToolBrowseEntry = ToolFilterEntry & {
  author?: string | undefined;
  description: string;
  pinned?: boolean | undefined;
};

export type PublicToolBrowseFilters = ToolFilters & {
  query: string;
  task: PublicToolTask | null;
};

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en");

const matchesSearchQuery = (
  entry: PublicToolBrowseEntry,
  query: string,
): boolean => {
  const terms = normalizeSearchText(query).trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }

  const haystack = normalizeSearchText(
    [
      entry.displayName,
      entry.description,
      entry.author ?? "",
      entry.slug,
      ...entry.tags,
      ...entry.jurisdictions,
    ].join(" "),
  );
  return terms.every((term) => haystack.includes(term));
};

export const filterPublicToolEntries = <T extends PublicToolBrowseEntry>(
  entries: readonly T[],
  { query, task, ...facets }: PublicToolBrowseFilters,
): readonly T[] => {
  return filterToolEntries(entries, facets).filter(
    (entry) =>
      (task === null || TASK_SLUGS[task].some((slug) => slug === entry.slug)) &&
      matchesSearchQuery(entry, query),
  );
};

export const PUBLIC_TOOL_GROUPS = [
  "skills",
  "data-sources",
  "included",
] as const;

export type PublicToolGroup = (typeof PUBLIC_TOOL_GROUPS)[number];

export const publicToolGroup = (
  entry: PublicToolBrowseEntry,
): PublicToolGroup => {
  if (entry.kind === "skill") {
    return "skills";
  }
  if (entry.kind === "native-tool" && entry.pinned) {
    return "included";
  }
  return "data-sources";
};

export const groupPublicToolEntries = <T extends PublicToolBrowseEntry>(
  entries: readonly T[],
): Readonly<Record<PublicToolGroup, readonly T[]>> => {
  const groups: Record<PublicToolGroup, T[]> = {
    skills: [],
    "data-sources": [],
    included: [],
  };
  for (const entry of entries) {
    groups[publicToolGroup(entry)].push(entry);
  }
  return groups;
};
