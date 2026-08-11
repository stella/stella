// Passive regression fixture for
// `require-query-key-factory/require-query-key-factory`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

type QueryKey = readonly unknown[];

type QueryFilters = {
  queryKey?: QueryKey;
  predicate?: (query: { queryKey: QueryKey }) => boolean;
};

declare const queryClient: {
  cancelQueries: (filters?: QueryFilters) => Promise<void>;
  invalidateQueries: (filters?: QueryFilters) => Promise<void>;
  removeQueries: (filters?: QueryFilters) => void;
  setQueryData: (queryKey: QueryKey, data: unknown) => void;
};

declare const organizationId: string;
declare const threadId: string;

const fixtureKeys = {
  all: ["fixture"] as const,
  scoped: (id: string) => [...fixtureKeys.all, id] as const,
};

declare const matchesFixtureThread: (
  queryKey: QueryKey,
  threadId: string,
) => boolean;

export const invalidatesInlineKey = async () => {
  await queryClient.invalidateQueries({
    // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
    queryKey: ["fixture", organizationId],
  });
};

export const invalidatesInlineConstKey = async () => {
  await queryClient.invalidateQueries({
    // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
    queryKey: ["fixture", organizationId] as const,
  });
};

export const cancelsInlineKey = async () => {
  await queryClient.cancelQueries({
    // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
    queryKey: ["fixture"],
  });
};

export const removesInlineKey = () => {
  queryClient.removeQueries({
    // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
    queryKey: ["fixture"],
  });
};

export const writesInlineKey = () => {
  // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
  queryClient.setQueryData(["fixture", organizationId], { items: [] });
};

export const invalidatesByInlinePositions = async () => {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
      query.queryKey.at(0) === "fixture" &&
      // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
      query.queryKey.at(2) !== "thread",
  });
};

export const invalidatesByInlineIndex = async () => {
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const queryKey = query.queryKey;
      // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
      return queryKey[0] === "fixture";
    },
  });
};

export const invalidatesBySuffixPosition = async () => {
  await queryClient.invalidateQueries({
    queryKey: fixtureKeys.all,
    // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
    predicate: (query) => query.queryKey.at(-1) !== "detail",
  });
};

// A hoisted filters object is the same call site one indirection away.
export const invalidatesViaHoistedFilters = async () => {
  const filters = {
    predicate: (query: { queryKey: QueryKey }) =>
      // oxlint-disable-next-line require-query-key-factory/require-query-key-factory
      query.queryKey.at(0) === "fixture",
  };
  await queryClient.invalidateQueries(filters);
};

// --- Cases the rule MUST NOT flag ---

export const invalidatesFactoryKey = async () => {
  await queryClient.invalidateQueries({
    queryKey: fixtureKeys.scoped(organizationId),
  });
  await queryClient.invalidateQueries({ queryKey: fixtureKeys.all });
};

export const writesFactoryKey = () => {
  queryClient.setQueryData(fixtureKeys.scoped(organizationId), { items: [] });
};

export const invalidatesViaNamedHelper = async () => {
  await queryClient.invalidateQueries({
    predicate: (query) => matchesFixtureThread(query.queryKey, threadId),
  });
};

// A blanket refresh carries no key to get wrong.
export const invalidatesEverything = async () => {
  await queryClient.invalidateQueries();
};

// The positional walk belongs in the helper the predicates call.
export const matchesFixtureKey = (queryKey: QueryKey): boolean =>
  queryKey.at(0) === "fixture" && queryKey.at(2) === "thread";
