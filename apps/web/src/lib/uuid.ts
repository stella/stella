import { panic, Result } from "better-result";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";

import { Temporal } from "@stll/time";

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

/** Create an unpredictable nonce for protocols that require UUID syntax. */
export const createRandomUuid = (): Uuid => {
  const value = uuidv4();
  if (!isUuid(value)) {
    panic("uuid v4 generator returned an invalid UUID");
  }
  return value;
};

/** Create a full-entropy value for nonces and other opaque uniqueness tokens. */
export const createRandomValue = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_VALUE_BYTES));
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
};

let ephemeralSequence = 0;

/** Non-security marker identity, including when browser cryptography is blocked. */
export const createEphemeralId = (): string => {
  const randomValue = Result.try(createRandomValue);
  if (randomValue.isOk()) {
    return randomValue.value;
  }
  ephemeralSequence += 1;
  return `ephemeral-${Temporal.Now.instant().epochMilliseconds.toString(36)}-${ephemeralSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const isUuid = (value: string): value is Uuid => UUID_PATTERN.test(value);
