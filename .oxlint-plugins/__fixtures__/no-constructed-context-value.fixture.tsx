// Passive regression fixture for
// `no-constructed-context-value/no-constructed-context-value`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { createContext, useMemo } from "react";
import type { Context, ReactNode } from "react";

declare const ThemeContext: Context<{ theme: string } | null>;
const Local = createContext<readonly string[]>([]);
const STATIC_THEME = { theme: "light" };

// --- Flagged: values built in render ---
export const ImportedObject = ({ theme }: { theme: string }) => (
  // oxlint-disable-next-line no-constructed-context-value/no-constructed-context-value -- fixture: an object for an imported React 19 context
  <ThemeContext value={{ theme }}>x</ThemeContext>
);
export const LocalArray = ({ theme }: { theme: string }) => (
  // oxlint-disable-next-line no-constructed-context-value/no-constructed-context-value -- fixture: an array for a local context with no Context suffix
  <Local value={[theme]}>x</Local>
);
export const RenderBinding = ({ theme }: { theme: string }) => {
  const value = { theme };
  return (
    // oxlint-disable-next-line no-constructed-context-value/no-constructed-context-value -- fixture: a render-scope binding to an object
    <ThemeContext.Provider value={value}>x</ThemeContext.Provider>
  );
};

// --- Allowed: memoized, module-scope, or passed-through values ---
export const Memoized = ({ theme }: { theme: string }) => {
  const value = useMemo(() => ({ theme }), [theme]);
  // expect-clean: no-constructed-context-value/no-constructed-context-value
  return <ThemeContext value={value}>x</ThemeContext>;
};
export const ModuleScope = ({ children }: { children: ReactNode }) => (
  // expect-clean: no-constructed-context-value/no-constructed-context-value
  <ThemeContext value={STATIC_THEME}>{children}</ThemeContext>
);
export const PassedThrough = ({ value }: { value: { theme: string } }) => (
  // expect-clean: no-constructed-context-value/no-constructed-context-value
  <ThemeContext value={value}>x</ThemeContext>
);
