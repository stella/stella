import { createContext, startTransition, use, useState } from "react";

import { panic } from "better-result";

import {
  useExternalSyncEffect,
  useKeyedState,
  useLatestCallback,
} from "@stll/ui/effects";

/**
 * What the app can change, each of which some list shows: from a sheet or a
 * row here, or, for chats, from another device the event stream names.
 */
export type ChangeKind =
  "chats" | "chatQueues" | "documents" | "matters" | "tasks" | "timers";

type Changes = {
  /** How many times each kind has changed here; a list keyed on it loads afresh. */
  readonly revisions: Readonly<Record<ChangeKind, number>>;
  readonly changed: (kind: ChangeKind) => void;
  /** Calls `listener` whenever something of one of `kinds` changes here. */
  readonly subscribe: (
    kinds: readonly ChangeKind[],
    listener: () => void,
  ) => () => void;
};

type ChangeListener = {
  readonly kinds: ReadonlySet<ChangeKind>;
  readonly listener: () => void;
};

const ChangesContext = createContext<Changes | null>(null);

const NONE: Readonly<Record<ChangeKind, number>> = {
  chats: 0,
  chatQueues: 0,
  documents: 0,
  matters: 0,
  tasks: 0,
  timers: 0,
};

/**
 * What the lists and the sheets that change them share. It sits above every
 * screen, so a task, matter, timer or document a sheet saves shows in the
 * lists underneath once the sheet closes.
 */
export const ChangesProvider = ({ children }: React.PropsWithChildren) => {
  const [revisions, setRevisions] = useState(NONE);
  const [listeners] = useState(() => new Set<ChangeListener>());
  // A transition, so the lists that reload keep showing what they have
  // until the new load settles, rather than falling back to a spinner. The
  // lists reload from this event, in the same transition.
  const changed = (kind: ChangeKind) => {
    startTransition(() => {
      setRevisions((current) => ({ ...current, [kind]: current[kind] + 1 }));
      for (const { kinds, listener } of listeners) {
        if (kinds.has(kind)) {
          listener();
        }
      }
    });
  };
  const subscribe = (kinds: readonly ChangeKind[], listener: () => void) => {
    const entry = { kinds: new Set(kinds), listener };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  };
  return (
    <ChangesContext value={{ changed, revisions, subscribe }}>
      {children}
    </ChangesContext>
  );
};

const useChanges = (): Changes =>
  use(ChangesContext) ??
  panic("the app's changes need a ChangesProvider above them");

/** How many times `kind` has changed; key a list's load on it. */
export const useRevision = (...kinds: readonly ChangeKind[]): string => {
  const { revisions } = useChanges();
  return kinds.map((kind) => revisions[kind]).join("-");
};

/** Tells the lists that something of `kind` changed. */
export const useChanged = (): ((kind: ChangeKind) => void) =>
  useChanges().changed;

/**
 * A list's load: started when the list mounts and again, in place, whenever
 * something of `kinds` changes here. The list stays mounted and the reload is
 * a transition, so it keeps showing what it has, and its own state, until
 * the new load settles. The setter replaces the load, for a pull to refresh
 * or a next page.
 */
export const useRevisedLoad = <T,>(
  start: () => Promise<T>,
  kinds: readonly ChangeKind[],
): readonly [Promise<T>, (load: Promise<T>) => void] => {
  const { subscribe } = useChanges();
  const [load, setLoad] = useState(start);
  // Called from `changed`, inside its transition.
  const reload = useLatestCallback(() => {
    setLoad(start());
  });
  // `kinds` is a fresh rest array each render; keep one per distinct list.
  const [watched] = useKeyedState(kinds.join(","), kinds);
  useExternalSyncEffect(
    () => subscribe(watched, reload),
    [watched, subscribe, reload],
  );
  return [load, setLoad] as const;
};
