import { useCallback as useStableCallback } from "react";

// Real TanStack producers keep these fixtures tied to the SDK's inference.
// Each suppressed violation must report, or unused-directive checking fails.
import {
  type DataTag as TaggedKey,
  type QueryClient,
  type QueryKey,
  infiniteQueryOptions,
  queryOptions,
} from "@tanstack/react-query";

declare const client: QueryClient;
declare const condition: boolean;

const fixtureKeys = {
  all: ["fixture"] as const,
  detail: (id: string) => [...fixtureKeys.all, id] as const,
};
const detailOptions = (id: string) =>
  queryOptions({
    queryKey: fixtureKeys.detail(id),
    queryFn: () => ({ title: id }),
  });
const listOptions = infiniteQueryOptions({
  queryKey: ["fixture", "pages"],
  queryFn: ({ pageParam }) => ({ page: pageParam }),
  initialPageParam: 0,
  getNextPageParam: ({ page }) => page + 1,
});

export const accepted = async () => {
  const options = detailOptions("one");
  const key = options.queryKey;
  const alias = key;
  const { queryKey: destructured } = options;
  client.getQueryData(detailOptions("one").queryKey);
  client.setQueryData(alias, { title: "updated" });
  client.getQueryData(destructured);
  client.getQueryData(listOptions.queryKey);
  client.getQueryData(condition ? key : detailOptions("two").queryKey);
  client.getQueryData(key satisfies QueryKey);
  // oxlint-disable-next-line typescript/dot-notation -- Exercise computed static key access.
  client.getQueryData(options["queryKey"]);
  // oxlint-disable-next-line typescript/dot-notation -- Exercise computed static method access.
  client["getQueryData"](key);
  return client.invalidateQueries({ queryKey: fixtureKeys.all });
};

export const rejected = () => {
  const options = detailOptions("one");
  const bare = fixtureKeys.detail("one");
  const alias = bare;
  const typedKey: QueryKey = options.queryKey;
  let mutable = options.queryKey;
  if (condition) {
    mutable = detailOptions("two").queryKey;
  }
  const fakeOptions = { queryKey: fixtureKeys.detail("one") };
  const { queryKey: fakeDestructured } = fakeOptions;
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Bare key factory loses the producer's data tag.
  client.getQueryData(fixtureKeys.detail("one"));
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Inferred writes must also retain the producer's tag.
  client.setQueryData(bare, { incorrectField: true });
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Multiple aliases cannot launder a bare key.
  client.getQueryData(alias);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Module-local or inline arrays are not options-derived.
  client.getQueryData(["fixture", "one"]);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Explicit generics can override producer inference.
  client.getQueryData<{ title: string }>(options.queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Explicit write generics likewise duplicate the producer contract.
  client.setQueryData<{ title: string }>(options.queryKey, { title: "one" });
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Widening discards the data tag.
  client.getQueryData(typedKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Mutable aliases are outside the const provenance contract.
  client.getQueryData(mutable);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key, typescript/no-unnecessary-type-assertion -- An assertion must not conceal lost inference.
  client.getQueryData(options.queryKey as QueryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- A property named queryKey alone does not tag a local array.
  client.getQueryData(fakeOptions.queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Destructuring the same bare object does not tag it either.
  client.getQueryData(fakeDestructured);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Every conditional branch must retain provenance.
  client.getQueryData(condition ? options.queryKey : bare);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key, typescript/dot-notation -- Computed static methods have the same cache contract.
  client["getQueryData"](bare);
};

export const shadowed = () => {
  const key = detailOptions("one").queryKey;
  client.getQueryData(key);
  {
    // oxlint-disable-next-line eslint/no-shadow -- Exercise lexical shadowing in the detector.
    const key = fixtureKeys.detail("one");
    // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Resolve lexical bindings, not identifier spellings.
    client.getQueryData(key);
  }
};

export const genericBoundary = (key: TaggedKey<QueryKey, { title: string }>) =>
  client.getQueryData(key);

export const destructuredBoundary = ({
  key,
}: {
  key: TaggedKey<QueryKey, { title: string }>;
}) => client.setQueryData(key, { title: "updated" });

export const untypedBoundary = (key: QueryKey) =>
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- A generic QueryKey parameter has no producer contract.
  client.getQueryData(key);

export const untypedOptionsBoundary = (options: { queryKey: QueryKey }) =>
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- An options-shaped parameter alone does not enforce a data tag.
  client.getQueryData(options.queryKey);

export const untypedDestructuredBoundary = ({
  queryKey,
}: {
  queryKey: QueryKey;
}) =>
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Destructuring must not hide a broad parameter contract.
  client.getQueryData(queryKey);

type TaggedTitle = TaggedKey<QueryKey, { title: string }>;
type CacheBoundaryOptions = { key: TaggedTitle };
export const namedBoundary = ({ key }: CacheBoundaryOptions) =>
  client.getQueryData(key);

const fakeOptionsFactory = () => ({ queryKey: fixtureKeys.detail("one") });
const localFactories = { detail: detailOptions, fake: fakeOptionsFactory };
const mixedOptions = () => {
  if (condition) {
    return detailOptions("one");
  }
  return fakeOptionsFactory();
};

const nestedCallbackFactory = () => {
  ["one"].map((id) => detailOptions(id));
  return fakeOptionsFactory();
};

export const localFactoryProvenance = () => {
  const alias = detailOptions;
  const options = condition ? alias("one") : localFactories.detail("two");
  client.getQueryData(options.queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Local factories must actually return tagged options.
  client.getQueryData(fakeOptionsFactory().queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Local member factories resolve to their actual body.
  client.getQueryData(localFactories.fake().queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Every explicit outer return must retain a tag.
  client.getQueryData(mixedOptions().queryKey);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- A nested callback's return cannot certify its enclosing factory.
  client.getQueryData(nestedCallbackFactory().queryKey);
};

const detailSeeds = () => [[detailOptions("one"), { title: "one" }]] as const;
export const seedIteration = () => {
  for (const [options, detail] of detailSeeds()) {
    client.setQueryData(options.queryKey, detail);
  }
};

export const useMemoizedFactory = () => {
  const createOptions = useStableCallback(
    (id: string) => detailOptions(id),
    [],
  );
  const options = createOptions("one");
  client.getQueryData(options.queryKey);
  const fakeFactory = useStableCallback(() => fakeOptionsFactory(), []);
  // oxlint-disable-next-line require-query-options-key/require-query-options-key -- Memoization must not conceal a factory that returns a bare key.
  client.getQueryData(fakeFactory().queryKey);
};
