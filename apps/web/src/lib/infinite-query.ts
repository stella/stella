/**
 * Seeds for a cursor-based `initialPageParam` in `infiniteQueryOptions`.
 *
 * TanStack Query infers `TPageParam` from `initialPageParam`. A bare
 * `initialPageParam: undefined` (or `null`) narrows to the literal `undefined`
 * (or `null`) type, which then mismatches the `string`-typed cursor used by the
 * queryFn and `getNextPageParam` and fails the `infiniteQueryOptions` overload.
 *
 * Returning the seed through a typed function keeps the full cursor union
 * (`string | undefined` / `string | null`) at the call site without an `as`
 * assertion: a function-call result is not subject to control-flow narrowing
 * the way a `const` initializer is.
 */
export const stringCursorSeed = (): string | undefined => undefined;

export const nullableStringCursorSeed = (): string | null => null;

type VisitCursorPagesOptions<TPage extends { nextCursor: string | null }> = {
  getPage: (cursor: string | undefined) => Promise<TPage>;
  visit: (page: TPage) => void;
  /** False stops after visiting this page, leaving its successor unread. */
  shouldContinue?: (page: TPage) => boolean;
};

type IterateCursorPagesOptions<TCursor, TPage> = {
  initialCursor: TCursor;
  getPage: (cursor: TCursor) => Promise<TPage>;
  getNextCursor: (page: TPage) => TCursor | null;
};

/** Each successor is fetched only when the consumer asks for another page. */
export async function* iterateCursorPages<TCursor, TPage>({
  initialCursor,
  getPage,
  getNextCursor,
}: IterateCursorPagesOptions<TCursor, TPage>): AsyncGenerator<TPage> {
  let cursor: TCursor | null = initialCursor;
  while (cursor !== null) {
    const page = await getPage(cursor);
    yield page;
    cursor = getNextCursor(page);
  }
}

// A page owns the only cursor that can select its successor.
export const visitCursorPages = async <
  TPage extends { nextCursor: string | null },
>({
  getPage,
  visit,
  shouldContinue,
}: VisitCursorPagesOptions<TPage>) => {
  for await (const page of iterateCursorPages({
    initialCursor: stringCursorSeed(),
    getPage,
    getNextCursor: (result) => result.nextCursor,
  })) {
    visit(page);
    if (shouldContinue?.(page) === false) {
      return;
    }
  }
};
