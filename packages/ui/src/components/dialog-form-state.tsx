"use client";

import { createContext, useContext, useId } from "react";

import { useLayoutSyncEffect } from "../effects/effects";

export type DialogFormSource = {
  dirty: boolean;
  onDiscard?: (() => void) | undefined;
};

export type DialogFormRegistry = {
  sources: Map<string, DialogFormSource>;
  clearConfirmation: () => void;
};

export const DialogFormContext = createContext<DialogFormRegistry | null>(null);

/** Forms report semantic changes, including edits made by custom controls. */
export const DialogFormState = ({
  dirty,
  onDiscard,
}: {
  dirty: boolean;
  onDiscard?: (() => void) | undefined;
}) => {
  const registry = useContext(DialogFormContext);
  const id = useId();
  useLayoutSyncEffect(() => {
    if (registry === null) {
      return undefined;
    }
    if (registry.sources.get(id)?.dirty !== dirty) {
      registry.clearConfirmation();
    }
    registry.sources.set(id, { dirty, onDiscard });
    return undefined;
  }, [dirty, id, onDiscard, registry]);
  useLayoutSyncEffect(
    () => () => {
      registry?.sources.delete(id);
    },
    [id, registry],
  );
  return null;
};
