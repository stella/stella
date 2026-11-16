import {
  createContext,
  startTransition,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { panic } from "better-result";

/**
 * What the app can change, each of which some list shows: from a sheet or a
 * row here, or, for chats, from another device the event stream names.
 */
export type ChangeKind = "chats" | "documents" | "matters" | "tasks" | "timers";

type Changes = {
  /** How many times each kind has changed here; a list keyed on it loads afresh. */
  readonly revisions: Readonly<Record<ChangeKind, number>>;
  readonly changed: (kind: ChangeKind) => void;
};

const ChangesContext = createContext<Changes | null>(null);

const NONE: Readonly<Record<ChangeKind, number>> = {
  chats: 0,
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
  // A transition, so the lists that reload keep showing what they have
  // until the new load settles, rather than falling back to a spinner.
  const changed = (kind: ChangeKind) => {
    startTransition(() => {
      setRevisions((current) => ({ ...current, [kind]: current[kind] + 1 }));
    });
  };
  return (
    <ChangesContext value={{ changed, revisions }}>{children}</ChangesContext>
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
  const revision = useRevision(...kinds);
  const [load, setLoad] = useState(start);
  const loadedFor = useRef(revision);
  const reload = useEffectEvent(() => {
    startTransition(() => {
      setLoad(start());
    });
  });
  useEffect(() => {
    if (loadedFor.current !== revision) {
      loadedFor.current = revision;
      reload();
    }
  }, [revision]);
  return [load, setLoad] as const;
};
