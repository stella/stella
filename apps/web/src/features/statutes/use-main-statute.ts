import { useMatch } from "@tanstack/react-router";

import type { PublicStatute } from "@/features/statutes/queries/statutes";

/**
 * The consolidation the main view currently renders, when the active route is
 * one of the public statute pages; `undefined` everywhere else, and also on a
 * statute route whose day no version was in force on: there is no text there
 * to be about.
 */
export const useMainStatute = (): PublicStatute | undefined => {
  const canonicalMatch = useMatch({
    from: "/law/$country/statutes/$slug/",
    shouldThrow: false,
  });
  const versionMatch = useMatch({
    from: "/law/$country/statutes/$slug/v/$version",
    shouldThrow: false,
  });
  const loaderData = canonicalMatch?.loaderData ?? versionMatch?.loaderData;
  return loaderData?.statute ?? undefined;
};
