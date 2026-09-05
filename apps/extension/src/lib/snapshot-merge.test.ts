import { describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";

import { mergeFrameSnapshots, type FrameSnapshot } from "./snapshot-merge";

const frame = (overrides: Partial<FrameSnapshot>): FrameSnapshot => ({
  elements: [],
  text: "",
  title: "",
  url: "",
  ...overrides,
});

describe("frame snapshot merge", () => {
  test("puts the top frame first and qualifies refs by frame", () => {
    const merged = mergeFrameSnapshots({
      frames: [
        {
          frameId: 3,
          snapshot: frame({
            elements: [{ name: "Inner", path: "0.1", role: "button" }],
            text: "inner text",
          }),
        },
        {
          frameId: 0,
          snapshot: frame({
            elements: [
              {
                href: "https://example.com/a",
                name: "A",
                path: "1.s.0",
                role: "link",
              },
            ],
            text: "outer text",
            title: "Outer",
            url: "https://example.com/",
          }),
        },
      ],
      textOffset: 0,
    });
    expect(merged).toEqual({
      elements: [
        {
          href: "https://example.com/a",
          name: "A",
          ref: "e:0:1.s.0",
          role: "link",
        },
        { name: "Inner", ref: "e:3:0.1", role: "button" },
      ],
      text: "outer text\n\ninner text",
      textOffset: 0,
      textTotalChars: 22,
      title: "Outer",
      url: "https://example.com/",
    });
  });

  test("pages long text by offset and reports the total", () => {
    const text = "x".repeat(BROWSER_CONTROL_LIMITS.pageTextChars + 100);
    const merged = mergeFrameSnapshots({
      frames: [{ frameId: 0, snapshot: frame({ text }) }],
      textOffset: BROWSER_CONTROL_LIMITS.pageTextChars,
    });
    expect(merged?.text).toHaveLength(100);
    expect(merged?.textOffset).toBe(BROWSER_CONTROL_LIMITS.pageTextChars);
    expect(merged?.textTotalChars).toBe(text.length);
    expect(
      mergeFrameSnapshots({
        frames: [{ frameId: 0, snapshot: frame({ text: "short" }) }],
        textOffset: 999,
      }),
    ).toMatchObject({ text: "", textOffset: 5, textTotalChars: 5 });
  });

  test("caps elements across frames and requires a top frame", () => {
    const elements = Array.from({ length: 250 }, (_, index) => ({
      name: `Button ${index}`,
      path: String(index),
      role: "button",
    }));
    const merged = mergeFrameSnapshots({
      frames: [
        { frameId: 0, snapshot: frame({ elements }) },
        { frameId: 1, snapshot: frame({ elements }) },
      ],
      textOffset: 0,
    });
    expect(merged?.elements).toHaveLength(BROWSER_CONTROL_LIMITS.elements);
    expect(
      mergeFrameSnapshots({
        frames: [{ frameId: 2, snapshot: frame({ text: "orphan" }) }],
        textOffset: 0,
      }),
    ).toBeNull();
  });
});
