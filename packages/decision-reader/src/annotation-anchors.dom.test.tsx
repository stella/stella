/* oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- This test container delegates clicks from nested answer marks; those marks own the keyboard handlers exercised here. */

import { act } from "react";
import { createRoot } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import { annotationTextAnchors } from "./annotation-anchors";
import type { AnnotationAnchorSource } from "./annotation-anchors";

test("overlapping answered selections keep the original highlight and activate each answer by keyboard", async () => {
  GlobalRegistrator.register();
  const previousActEnvironment = Reflect.get(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const text = "selected words";
  const normal = {
    blockAnchorId: "p-1",
    color: "yellow",
    endOffset: text.length,
    id: "original-highlight",
    kind: "highlight",
    startOffset: 0,
    style: "highlight",
  } as const satisfies AnnotationAnchorSource;
  const answer = {
    ...normal,
    activationLabel: "Open first answer",
    color: "sky",
    id: "answer-one",
    style: "underline",
  } as const satisfies AnnotationAnchorSource;
  const second = {
    ...answer,
    activationLabel: "Open second answer",
    id: "answer-two",
  };
  const activations: string[] = [];
  const anchors = annotationTextAnchors([normal, answer, second]);
  try {
    await act(async () => {
      root.render(
        <div
          onClick={(event) => {
            if (!(event.target instanceof Element)) {
              return;
            }
            const id = event.target.closest<HTMLElement>("[data-annotation-id]")
              ?.dataset["annotationId"];
            if (id !== undefined) {
              activations.push(id);
            }
          }}
        >
          {anchors.map((anchor) => (
            <span key={anchor.key}>
              {anchor.render(text.slice(anchor.start, anchor.end))}
            </span>
          ))}
        </div>,
      );
    });
    expect(container.textContent).toBe(text);
    const highlight =
      container.querySelector('[data-annotation-id="original-highlight"]') ??
      panic("Missing original highlight");
    // A reader's highlight takes the lighter reading wash, not a find's.
    expect(highlight.classList.contains("bg-(--text-mark)/18")).toBe(true);
    expect(highlight.classList.contains("bg-(--text-mark)/30")).toBe(false);
    for (const [id, label, key] of [
      ["answer-one", "Open first answer", "Enter"],
      ["answer-two", "Open second answer", " "],
    ] as const) {
      const mark = container.querySelector(`[data-annotation-id="${id}"]`);
      if (!(mark instanceof HTMLElement)) {
        panic("Missing answer activation");
      }
      expect(mark.getAttribute("role")).toBe("button");
      expect(mark.getAttribute("aria-label")).toBe(label);
      expect(mark.tabIndex).toBe(0);
      expect(mark.classList.contains("underline")).toBe(true);
      mark.focus();
      expect(document.activeElement).toBe(mark);
      await act(async () => {
        mark.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(activations.at(-1)).toBe(id);
    }
    expect(activations).toEqual(["answer-one", "answer-two"]);
    const commentAnchors = annotationTextAnchors([
      {
        ...normal,
        id: "original-comment",
        kind: "comment",
        color: null,
        style: null,
      },
      answer,
      second,
    ]);
    await act(async () => {
      root.render(
        <>
          {commentAnchors.map((anchor) => (
            <span key={anchor.key}>
              {anchor.render(text.slice(anchor.start, anchor.end))}
            </span>
          ))}
        </>,
      );
    });
    const comment =
      container.querySelector('[data-annotation-id="original-comment"]') ??
      panic("Missing original comment");
    expect(comment.classList.contains("decoration-dotted")).toBe(true);
    expect(container.querySelectorAll('[role="button"]').length).toBe(2);
    expect(container.textContent).toBe(text);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    if (previousActEnvironment === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Reflect.set(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        previousActEnvironment,
      );
    }
    await GlobalRegistrator.unregister();
  }
});
