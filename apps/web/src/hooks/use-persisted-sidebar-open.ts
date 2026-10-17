import { useState, useSyncExternalStore } from "react";

import type * as v from "valibot";

import type { PersistedStateDefinition } from "@/hooks/persisted-storage-adapter";
import {
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;
type SidebarScope = {
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
};

export const readPersistedSidebarOpen = <
  TSchema extends v.BaseSchema<unknown, boolean | null, v.BaseIssue<unknown>>,
>(
  entry: PersistedStateDefinition<TSchema, SidebarScope>,
  scope: SidebarScope,
) => readPersistedState(entry, scope);

export const usePersistedSidebarOpen = <
  TSchema extends v.BaseSchema<unknown, boolean | null, v.BaseIssue<unknown>>,
>({
  defaultOpen,
  entry,
  hydrateFromStorage,
  scope,
}: {
  defaultOpen: boolean;
  entry: PersistedStateDefinition<TSchema, SidebarScope>;
  hydrateFromStorage: boolean;
  scope: SidebarScope;
}) => {
  const storedOpen = useSyncExternalStore(
    noopSubscribe,
    () =>
      hydrateFromStorage
        ? (readPersistedSidebarOpen(entry, scope) ?? defaultOpen)
        : defaultOpen,
    () => defaultOpen,
  );
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? storedOpen;

  const persistOpen = (nextOpen: boolean) => {
    writePersistedState(entry, scope, nextOpen);
  };

  return { open, persistOpen, setOpen: setOpenOverride };
};
