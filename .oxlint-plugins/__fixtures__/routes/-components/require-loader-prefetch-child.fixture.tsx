// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// A colocated route component (dash-prefixed `-components` directory, the
// codebase convention TanStack Router excludes from route generation) that
// suspends on a query factory. It is imported by the two sibling route
// fixtures below via `@/routes/...`, which is what the cross-file, one-hop
// check in the rule follows.
//
// This file has no `createFileRoute` of its own, so linting it directly (as
// oxlint does — it is still a file under `__fixtures__`) must NOT flag
// anything here: the loader-prefetch invariant only applies to the route file
// that imports this component, never to the component file in isolation.

import { useSuspenseQuery } from "@tanstack/react-query";

declare const childEntityOptions: (id: string) => {
  queryKey: readonly ["child-entity", string];
  queryFn: () => Promise<string>;
};

export function ChildComponent() {
  // No createFileRoute in this file — NOT flagged here, regardless of the
  // route(s) that import this component.
  const entity = useSuspenseQuery(childEntityOptions("id"));
  return entity.data;
}
