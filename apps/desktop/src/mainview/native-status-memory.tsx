import { createContext, use, useState } from "react";
import type * as React from "react";

/** The last answer each native status read gave, keyed by the read. */
export type NativeStatusMemory = Map<() => Promise<unknown>, unknown>;

const NativeStatusMemoryContext = createContext<NativeStatusMemory | null>(
  null,
);

/**
 * Remembers native status answers while the settings window lives, so a
 * section shown again (another page, then back) starts from its last answer
 * instead of empty while a slow read, such as a CLI asked for its sign-in,
 * runs. Without this provider nothing is remembered.
 */
export const NativeStatusMemoryProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [memory] = useState<NativeStatusMemory>(() => new Map());
  return (
    <NativeStatusMemoryContext value={memory}>
      {children}
    </NativeStatusMemoryContext>
  );
};

export const useNativeStatusMemory = () => use(NativeStatusMemoryContext);
