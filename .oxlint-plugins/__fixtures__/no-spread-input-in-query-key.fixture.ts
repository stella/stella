// Passive regression fixture for
// `no-spread-input-in-query-key/no-spread-input-in-query-key`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

const rootKeys = {
  all: ["root"] as const,
  byId: (id: string) => [...rootKeys.all, id] as const,
};

const input = ["leaked"] as const;
const inputKeys = ["leaked"] as const;
const filterInput = { filters: ["leaked"] as const };

// Direct `queryKey` arrays must not spread caller-controlled identifiers.
export const directQueryOptions = {
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  queryKey: [...input],
};

export const directConstQueryOptions = {
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  queryKey: [...input] as const,
};

export const memberExpressionQueryOptions = {
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  queryKey: [...filterInput.filters] as const,
};

export const bareKeysIdentifierQueryOptions = {
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  queryKey: [...inputKeys] as const,
};

export const objectSpreadQueryOptions = {
  queryKey: [
    ...rootKeys.all,
    {
      // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
      ...filterInput,
    },
  ] as const,
};

export const nestedObjectSpreadQueryOptions = {
  queryKey: [
    ...rootKeys.all,
    {
      filters: {
        // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
        ...filterInput,
      },
    },
  ] as const,
};

export const fixtureKeys = {
  all: ["fixture"] as const,

  // Query-key factories must not spread caller-controlled identifiers.
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  list: (key: readonly unknown[]) => [...fixtureKeys.all, ...key] as const,

  // --- Cases the rule MUST NOT flag ---

  // Composition call spread.
  detail: (id: string) => [...rootKeys.byId(id)] as const,

  // Composition member spread plus explicit identity fields.
  page: (key: { limit: number; workspaceId: string }) =>
    [
      ...fixtureKeys.all,
      { limit: key.limit, workspaceId: key.workspaceId },
    ] as const,
};

export const constObjectKeys = {
  all: ["const-object"] as const,

  // Whole-object `as const` wrappers must not hide factory returns.
  // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
  list: (key: readonly unknown[]) => [...constObjectKeys.all, ...key] as const,
} as const;

export const nestedFixtureKeys = {
  skills: {
    all: ["nested-skills"] as const,
    list: (key: { filters: readonly string[] }) =>
      [
        ...nestedFixtureKeys.skills.all,
        {
          // oxlint-disable-next-line no-spread-input-in-query-key/no-spread-input-in-query-key
          ...key,
        },
      ] as const,
  },
} as const;

export const safeQueryOptions = {
  queryKey: [...rootKeys.all, "safe"] as const,
};

export const safeConditionalFieldQueryOptions = {
  queryKey: [
    ...rootKeys.all,
    {
      ...(filterInput.filters.length > 0 && {
        filters: filterInput.filters,
      }),
    },
  ] as const,
};
