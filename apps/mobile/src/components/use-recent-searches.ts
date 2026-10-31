import { useEffect, useRef, useState } from "react";

import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { deviceAccountStore } from "@/native/account-store";
import {
  listServerRecentSearches,
  openRecentSearches,
  recentSearchesKey,
} from "@/state/recent-searches";
import type { RecentSearches } from "@/state/recent-searches";

/**
 * The account's recent searches: the ones run in the app, which this device
 * keeps under the account's server and person, then the server's own. A
 * search is remembered on the device only; clearing forgets the device's
 * and hides the server's here. The server's list is a nicety, so a failure
 * to read it lists the device's alone.
 */
export const useRecentSearches = (source: AccessTokenSource) => {
  const { serverUrl, userId } = source.session();
  const key = recentSearchesKey(serverUrl, userId);
  // The list belongs to the key it was loaded under; another account's
  // shows none until its own loads.
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly searches: readonly string[];
  }>({ key, searches: [] });
  const recents = useRef<RecentSearches | null>(null);

  useEffect(() => {
    let current = true;
    recents.current = openRecentSearches({
      key,
      loadServer: async () => await listServerRecentSearches({ fetch, source }),
      now: epochMilliseconds,
      onChange: (searches) => {
        if (current) {
          setLoaded({ key, searches });
        }
      },
      store: deviceAccountStore,
    });
    return () => {
      current = false;
    };
  }, [key, source]);

  return {
    searches: loaded.key === key ? loaded.searches : [],
    remember: (query: string) => {
      void recents.current?.remember(query);
    },
    clear: () => {
      void recents.current?.clear();
    },
  };
};
