import { panic } from "better-result";
import { v7 as uuidv7 } from "uuid";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Create a time-ordered UUID in browser, SSR, and test runtimes. */
export const createUuid = (): Uuid => {
  const value = uuidv7();
  if (!isUuid(value)) {
    panic("uuid v7 generator returned an invalid UUID");
  }
  return value;
};

const RANDOM_VALUE_BYTES = 16;

/** Create a full-entropy value for nonces and other opaque uniqueness tokens. */
export const createRandomValue = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_VALUE_BYTES));
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
};

const isUuid = (value: string): value is Uuid => UUID_PATTERN.test(value);
