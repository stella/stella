import { expect, test } from "bun:test";

import {
  servedStatuteVersionChanges,
  STATUTE_VERSION_CHANGES_METHOD,
} from "./statute-version-changes";

const base = {
  documentId: "0198e331-e578-7000-8000-000000000001",
  payloadRevision: 2n,
};
const counts = {
  provisions: { changed: 1, added: 0, removed: 0 },
  words: { inserted: 2, deleted: 1 },
};
const stored = {
  type: "compared",
  method: STATUTE_VERSION_CHANGES_METHOD,
  payloadRevision: 3,
  base: { documentId: base.documentId, payloadRevision: 2 },
  counts,
};

test("counts require the current method and both current endpoints", () => {
  const options = { stored, payloadRevision: 3n, base };
  expect(servedStatuteVersionChanges(options)).toEqual(counts);
  expect(servedStatuteVersionChanges({ ...options, base: null })).toBeNull();
  expect(
    servedStatuteVersionChanges({
      ...options,
      base: { ...base, documentId: "0198e331-e578-7000-8000-000000000002" },
    }),
  ).toBeNull();
  expect(
    servedStatuteVersionChanges({
      ...options,
      base: { ...base, payloadRevision: 4n },
    }),
  ).toBeNull();
  expect(
    servedStatuteVersionChanges({ ...options, payloadRevision: 4n }),
  ).toBeNull();
  expect(
    servedStatuteVersionChanges({
      ...options,
      stored: { ...stored, method: STATUTE_VERSION_CHANGES_METHOD + 1 },
    }),
  ).toBeNull();
});
