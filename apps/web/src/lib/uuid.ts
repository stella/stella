import { v7 as uuidv7 } from "uuid";

/** Create a time-ordered UUID in browser, SSR, and test runtimes. */
export const createUuid = () => uuidv7();
