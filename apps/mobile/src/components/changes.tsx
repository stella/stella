import { createContext, use, useState } from "react";

import { panic } from "better-result";

/** What the app can change from a sheet, each of which some list shows. */
export type ChangeKind = "documents" | "matters" | "tasks" | "timers";

type Changes = {
  /** How many times each kind has changed here; a list keyed on it loads afresh. */
  readonly revisions: Readonly<Record<ChangeKind, number>>;
  readonly changed: (kind: ChangeKind) => void;
};

const ChangesContext = createContext<Changes | null>(null);

const NONE: Readonly<Record<ChangeKind, number>> = {
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
  const changed = (kind: ChangeKind) => {
    setRevisions((current) => ({ ...current, [kind]: current[kind] + 1 }));
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
