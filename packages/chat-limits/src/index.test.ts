import { expect, test } from "bun:test";

import {
  CHAT_CONTEXT_FILE_MAX_BYTES,
  CHAT_CONTEXT_FILE_MAX_MEGABYTES,
} from "./index";

test("byte budget matches the megabytes source", () => {
  expect(CHAT_CONTEXT_FILE_MAX_MEGABYTES).toBe(10);
  expect(CHAT_CONTEXT_FILE_MAX_BYTES).toBe(
    CHAT_CONTEXT_FILE_MAX_MEGABYTES * 1024 * 1024,
  );
});
