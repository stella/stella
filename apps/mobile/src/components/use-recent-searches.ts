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
  const [searches, setSearches] = useState<readonly string[]>([]);
  const recents = useRef<RecentSearches | null>(null);

  useEffect(() => {
    let current = true;
    recents.current = openRecentSearches({
      key,
      loadServer: async () => await listServerRecentSearches({ fetch, source }),
      now: epochMilliseconds,
      onChange: (next) => {
        if (current) {
          setSearches(next);
        }
      },
      store: deviceAccountStore,
    });
    return () => {
      current = false;
    };
  }, [key, source]);

  return {
    searches,
    remember: (query: string) => {
      void recents.current?.remember(query);
    },
    clear: () => {
      void recents.current?.clear();
    },
  };
};
