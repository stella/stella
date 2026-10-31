import { useEffect, useState } from "react";

import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { deviceAccountStore } from "@/native/account-store";
import {
  clearRecents,
  listServerRecentSearches,
  mergeRecentSearches,
  NO_RECENTS,
  readStoredRecents,
  recentSearchesKey,
  rememberSearch,
} from "@/state/recent-searches";
import type { RecentSearch, StoredRecents } from "@/state/recent-searches";

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
  const [stored, setStored] = useState<StoredRecents>(NO_RECENTS);
  const [server, setServer] = useState<readonly RecentSearch[]>([]);

  useEffect(() => {
    let current = true;
    void (async () => {
      const [kept, recorded] = await Promise.all([
        deviceAccountStore.read(key).catch(() => null),
        listServerRecentSearches({ fetch, source }),
      ]);
      if (current) {
        setStored(readStoredRecents(kept));
        setServer(recorded.unwrapOr([]));
      }
    })();
    return () => {
      current = false;
    };
  }, [key, source]);

  const keep = (next: StoredRecents) => {
    setStored(next);
    // Best effort: a search not kept is only missing from the list next time.
    void deviceAccountStore
      .write(key, JSON.stringify(next))
      .catch(() => undefined);
  };

  return {
    searches: mergeRecentSearches(stored, server),
    remember: (query: string) => {
      keep(rememberSearch(stored, query, epochMilliseconds()));
    },
    clear: () => {
      keep(clearRecents(epochMilliseconds()));
    },
  };
};
