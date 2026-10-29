import { expect, test } from "bun:test";

import { dictationPreferences } from "./preferences";

test("each action remembers its own audio choice after reload", async () => {
  const values = new Map<string, string>();
  const store = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const first = dictationPreferences(store);
  expect((await first.loadChoice("export")).unwrap()).toEqual({
    content: "audio",
    cleaned: false,
  });
  expect(
    (
      await first.rememberChoice("export", { content: "audio", cleaned: true })
    ).isOk(),
  ).toBe(true);
  const reloaded = dictationPreferences(store);
  expect((await reloaded.loadChoice("export")).unwrap()).toEqual({
    content: "audio",
    cleaned: true,
  });
  expect((await reloaded.loadChoice("save-to-matter")).unwrap()).toEqual({
    content: "audio",
    cleaned: false,
  });
  expect(
    (
      await reloaded.rememberChoice("save-to-matter", {
        content: "audio",
        cleaned: true,
      })
    ).isOk(),
  ).toBe(true);
  expect(
    (await dictationPreferences(store).loadChoice("save-to-matter")).unwrap()
      .cleaned,
  ).toBe(true);
});

test("corrupt preferences and storage faults surface instead of overwriting", async () => {
  for (const text of [
    "{",
    '{"content":"transcript","cleaned":true}',
    '{"content":"audio","cleaned":"true"}',
  ]) {
    const choices = dictationPreferences({
      read: async () => text,
      write: async () => {},
    });
    expect((await choices.loadChoice("export")).isErr()).toBe(true);
  }
  const failed = dictationPreferences({
    read: async () => {
      throw new TypeError("Unavailable");
    },
    write: async () => {
      throw new TypeError("Unavailable");
    },
  });
  expect((await failed.loadChoice("export")).isErr()).toBe(true);
  expect(
    (
      await failed.rememberChoice("export", {
        content: "audio",
        cleaned: false,
      })
    ).isErr(),
  ).toBe(true);
});
