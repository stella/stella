import { createContext } from "react";

/**
 * The matter of the thread on screen, if it has one: a mention in its text
 * that names no matter of its own lives in this one.
 */
export const ThreadMatter = createContext<string | undefined>(undefined);
