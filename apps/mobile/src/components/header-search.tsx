import { createContext, use, useRef, useState } from "react";

import { panic } from "better-result";

/** How long typing pauses before a search counts as settled. */
const SETTLE_MS = 300;

type HeaderSearch = {
  /** What the field holds now, for a list that filters as it is typed. */
  readonly query: string;
  /** What it held once typing paused, for a list that asks a server. */
  readonly settledQuery: string;
  readonly setQuery: (query: string) => void;
};

const HeaderSearchContext = createContext<HeaderSearch | null>(null);

/**
 * What is typed into the search field of the app's header, which the
 * platform draws, for the list under it to filter by.
 */
export const HeaderSearchProvider = ({ children }: React.PropsWithChildren) => {
  const [query, setTyped] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setQuery = (next: string) => {
    setTyped(next);
    clearTimeout(pause.current);
    pause.current = setTimeout(() => {
      setSettledQuery(next);
    }, SETTLE_MS);
  };
  return (
    <HeaderSearchContext value={{ query, setQuery, settledQuery }}>
      {children}
    </HeaderSearchContext>
  );
};

export const useHeaderSearch = (): HeaderSearch =>
  use(HeaderSearchContext) ??
  panic("useHeaderSearch needs a HeaderSearchProvider above it");
