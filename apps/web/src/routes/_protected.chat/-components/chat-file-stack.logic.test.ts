import { describe, expect, test } from "bun:test";

import {
  CHAT_FILE_STACK_MAX_TILES,
  layoutFileStack,
} from "./chat-file-stack.logic";

const named = (count: number) =>
  Array.from({ length: count }, (_, index) => `file-${index}`);

describe("layoutFileStack", () => {
  test("every named file count up to the server total: tiles plus overflow cover the total", () => {
    for (let namedCount = 0; namedCount <= 8; namedCount += 1) {
      for (let extra = 0; extra <= 4; extra += 1) {
        const files = named(namedCount);
        const layout = layoutFileStack({
          fileCount: namedCount + extra,
          files,
        });

        expect(layout.total).toBe(namedCount + extra);
        expect(layout.tiles).toEqual(files.slice(0, CHAT_FILE_STACK_MAX_TILES));
        expect(layout.tiles.length + layout.overflowCount).toBe(layout.total);
        expect(layout.unnamedCount).toBe(extra);
        expect(layout.overflowCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("no files renders nothing", () => {
    expect(layoutFileStack({ fileCount: 0, files: [] })).toEqual({
      overflowCount: 0,
      tiles: [],
      total: 0,
      unnamedCount: 0,
    });
  });

  test("a stale count below the named files never goes negative", () => {
    const layout = layoutFileStack({ fileCount: 1, files: named(5) });

    expect(layout.total).toBe(5);
    expect(layout.overflowCount).toBe(2);
    expect(layout.unnamedCount).toBe(0);
  });
});
