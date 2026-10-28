import { createContext, use, useState } from "react";

import { panic } from "better-result";
import { useWindowDimensions } from "react-native";

import { useLayoutMetrics } from "@/native/layout-metrics";
import { deriveLayout } from "@/state/layout";
import type { Layout } from "@/state/layout";

export type ThreadSelection = {
  readonly threadId: string;
  readonly matterId?: string | undefined;
  readonly title?: string | undefined;
  /** A conversation the phone opened under a new id, not yet sent. */
  readonly fresh?: boolean | undefined;
};

export type MatterSelection = {
  readonly workspaceId: string;
  readonly name: string;
};

export type TaskSelection = {
  readonly entityId: string;
  readonly workspaceId: string;
};

type Selections = {
  readonly thread: ThreadSelection | null;
  readonly matter: MatterSelection | null;
  readonly task: TaskSelection | null;
};

type Selection = Selections & {
  readonly select: <K extends keyof Selections>(
    kind: K,
    value: Selections[K],
  ) => void;
};

const SelectionContext = createContext<Selection | null>(null);

const NOTHING: Selections = { matter: null, task: null, thread: null };

/**
 * What each tab shows beside its list where the window has room for two
 * columns. It sits above the tabs, so a tab keeps its selection while
 * another is open, and narrowing the window to one column forgets nothing.
 */
export const SelectionProvider = ({ children }: React.PropsWithChildren) => {
  const [selections, setSelections] = useState(NOTHING);
  const select = <K extends keyof Selections>(
    kind: K,
    value: Selections[K],
  ) => {
    setSelections((current) => ({ ...current, [kind]: value }));
  };
  return (
    <SelectionContext value={{ ...selections, select }}>
      {children}
    </SelectionContext>
  );
};

export const useSelection = (): Selection =>
  use(SelectionContext) ??
  panic("useSelection needs a SelectionProvider above it");

/** One column or two, for the window as it is now. */
export const useLayout = (): Layout => {
  const { height, width } = useWindowDimensions();
  const metrics = useLayoutMetrics();
  return deriveLayout({ height, metrics, width });
};
