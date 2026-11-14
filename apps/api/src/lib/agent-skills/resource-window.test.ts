import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  SKILL_RESOURCE_WINDOW_CHARS,
  windowSkillResource,
} from "@/api/lib/agent-skills/resource-window";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const SKILL_ID = toSafeId<"agentSkill">("0195f3a0-0000-7000-8000-000000000001");
const OTHER_SKILL_ID = toSafeId<"agentSkill">(
  "0195f3a0-0000-7000-8000-000000000002",
);
const PATH = "references/commentary.txt";
const WINDOW = SKILL_RESOURCE_WINDOW_CHARS;

const read = (content: string, cursor?: string, path = PATH) =>
  windowSkillResource({
    content,
    cursor,
    path,
    skillId: SKILL_ID,
    skillName: "commentary",
  });

/** Follows nextCursor to the end, checking each window on the way. */
const readAll = (content: string) => {
  const windows: string[] = [];
  let cursor: string | undefined;
  for (
    let step = 0;
    step <= Math.ceil(content.length / WINDOW) + 1;
    step += 1
  ) {
    const window = read(content, cursor);
    if (window.type !== "window") {
      return panic("A cursor the read issued was refused");
    }
    expect(window.charCount).toBe(content.length);
    expect(window.content.length).toBeLessThanOrEqual(WINDOW);
    expect(window.content.length).toBeGreaterThan(0);
    // No window starts or ends inside a surrogate pair.
    expect(window.content.isWellFormed()).toBe(true);
    windows.push(window.content);
    if (window.nextCursor === null) {
      return windows;
    }
    cursor = window.nextCursor;
  }
  return panic("The windows never reached the end");
};

const issuedCursor = (content: string) => {
  const first = read(content);
  if (first.type !== "window" || first.nextCursor === null) {
    return panic("Expected a continuation");
  }
  return first.nextCursor;
};

describe("skill resource windows", () => {
  test("a read never returns more than a model may hold at once", () => {
    expect(WINDOW).toBe(LIMITS.agentSkillResourceModelContextMaxChars);
    expect(WINDOW).toBeLessThan(LIMITS.agentSkillResourceMaxChars);
  });

  test("a resource within one window comes back whole with no cursor", () => {
    const window = read("Short methodology.");
    expect(window).toEqual({
      type: "window",
      content: "Short methodology.",
      charCount: 18,
      nextCursor: null,
    });
  });

  test("a stored resource at the cap reads back exactly across windows", () => {
    // Czech diacritics are one UTF-16 unit but several UTF-8 bytes.
    const phrase = "Komentář k § 2950 občanského zákoníku. ";
    const content = phrase
      .repeat(Math.ceil(LIMITS.agentSkillResourceMaxChars / phrase.length))
      .slice(0, LIMITS.agentSkillResourceMaxChars);

    const windows = readAll(content);

    expect(windows.join("")).toBe(content);
    expect(windows).toHaveLength(
      Math.ceil(LIMITS.agentSkillResourceMaxChars / WINDOW),
    );
  });

  test("a surrogate pair at a window edge stays in one window", () => {
    const astral = "𝔄";
    expect(astral).toHaveLength(2);
    // The pair occupies the last unit of the first window and the first unit
    // of the second, so a plain slice would split it.
    const content = `${"a".repeat(WINDOW - 1)}${astral}${"b".repeat(10)}`;

    const windows = readAll(content);

    expect(windows.join("")).toBe(content);
    expect(windows.at(0)).toBe("a".repeat(WINDOW - 1));
    expect(windows.at(1)?.startsWith(astral)).toBe(true);
  });

  test("pairs packed across every edge reconstruct without lone surrogates", () => {
    const content = "😀ž".repeat(WINDOW);

    expect(readAll(content).join("")).toBe(content);
  });

  test("the last window has a null nextCursor", () => {
    const content = "x".repeat(WINDOW + 5);
    const second = read(content, issuedCursor(content));

    expect(second).toEqual({
      type: "window",
      content: "xxxxx",
      charCount: WINDOW + 5,
      nextCursor: null,
    });
  });

  test("a cursor from another resource of the same skill is refused", () => {
    const content = "y".repeat(WINDOW + 1);
    const cursor = issuedCursor(content);

    expect(read(content, cursor, "references/other.txt")).toEqual({
      type: "invalid-cursor",
    });
  });

  test("a cursor from the same path in another skill is refused", () => {
    const content = "y".repeat(WINDOW + 1);
    const cursor = issuedCursor(content);
    const readElsewhere = (skillId: typeof SKILL_ID | null) =>
      windowSkillResource({
        content,
        cursor,
        path: PATH,
        skillId,
        skillName: "commentary",
      });

    expect(readElsewhere(OTHER_SKILL_ID).type).toBe("invalid-cursor");
    // A shipped skill with the same slug is another subject as well.
    expect(readElsewhere(null).type).toBe("invalid-cursor");
  });

  test("a cursor is refused once the resource changes", () => {
    const content = "z".repeat(WINDOW + 1);
    const cursor = issuedCursor(content);

    expect(read(`${content}!`, cursor).type).toBe("invalid-cursor");
    expect(read(content.replace("z", "Z"), cursor).type).toBe("invalid-cursor");
    expect(read(content, cursor).type).toBe("window");
  });

  test("a tampered cursor is refused", () => {
    const content = "q".repeat(WINDOW + 1);
    const cursor = issuedCursor(content);
    const [prefix, offset, ...rest] = cursor.split(".");

    expect(read(content, [prefix, "1", ...rest].join(".")).type).toBe(
      "invalid-cursor",
    );
    expect(offset).toBe(String(WINDOW));
    expect(read(content, `${cursor}x`).type).toBe("invalid-cursor");
  });
});
