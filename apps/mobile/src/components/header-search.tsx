import { createContext, use, useRef, useState } from "react";

import { panic } from "better-result";

/** How long typing pauses before a search counts as settled. */
const SETTLE_MS = 300;

type HeaderSearch = {
  /** Whether the field is open under the header. */
  readonly searching: boolean;
  readonly setSearching: (searching: boolean) => void;
  /** What the field holds now, for a list that filters as it is typed. */
  readonly query: string;
  /** What it held once typing paused, for a list that asks a server. */
  readonly settledQuery: string;
  readonly setQuery: (query: string) => void;
};

type SearchState = {
  readonly tab: string;
  readonly searching: boolean;
  readonly query: string;
  readonly settledQuery: string;
};

const closedSearch = (tab: string): SearchState => ({
  query: "",
  searching: false,
  settledQuery: "",
  tab,
});

const HeaderSearchContext = createContext<HeaderSearch | null>(null);

/**
 * What is typed into the search field of the app's header, which the
 * platform draws, for the list under it to filter by. The search belongs to
 * the tab it was typed on: moving to another tab closes it, so a query never
 * filters a list it was not typed over.
 */
export const HeaderSearchProvider = ({
  activeTab,
  children,
}: React.PropsWithChildren<{
  /** The tab on screen; none while a screen is pushed over the tabs. */
  activeTab: string | undefined;
}>) => {
  const [search, setSearch] = useState(() => closedSearch(activeTab ?? ""));
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (activeTab !== undefined && search.tab !== activeTab) {
    setSearch(closedSearch(activeTab));
  }
  const setQuery = (next: string) => {
    const { tab } = search;
    setSearch((current) => ({ ...current, query: next }));
    clearTimeout(pause.current);
    // A pause that ends after the tab changed settles nothing on the new one.
    pause.current = setTimeout(() => {
      setSearch((current) =>
        current.tab === tab && current.searching
          ? { ...current, settledQuery: next }
          : current,
      );
    }, SETTLE_MS);
  };
  const setSearching = (searching: boolean) => {
    if (!searching) {
      clearTimeout(pause.current);
    }
    setSearch((current) =>
      searching ? { ...current, searching } : closedSearch(current.tab),
    );
  };
  return (
    <HeaderSearchContext
      value={{
        query: search.query,
        searching: search.searching,
        setQuery,
        setSearching,
        settledQuery: search.settledQuery,
      }}
    >
      {children}
    </HeaderSearchContext>
  );
};

export const useHeaderSearch = (): HeaderSearch =>
  use(HeaderSearchContext) ??
  panic("useHeaderSearch needs a HeaderSearchProvider above it");
