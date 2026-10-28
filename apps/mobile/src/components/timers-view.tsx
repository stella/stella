import { createContext, use, useState } from "react";

import { panic } from "better-result";

type TimersView = {
  /** Counts the timers started or changed here, so the list loads afresh after each. */
  readonly revision: number;
  readonly timersChanged: () => void;
};

const TimersViewContext = createContext<TimersView | null>(null);

/**
 * What the timers screen and the sheet that starts one share. It sits above the
 * tabs, so a timer started from its sheet shows on the screen underneath.
 */
export const TimersViewProvider = ({ children }: React.PropsWithChildren) => {
  const [revision, setRevision] = useState(0);
  const timersChanged = () => {
    setRevision((current) => current + 1);
  };
  return (
    <TimersViewContext value={{ revision, timersChanged }}>
      {children}
    </TimersViewContext>
  );
};

export const useTimersView = (): TimersView =>
  use(TimersViewContext) ??
  panic("useTimersView needs a TimersViewProvider above it");
