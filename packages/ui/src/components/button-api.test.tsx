import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Button } from "./button";

const classesOf = (markup: string): string[] =>
  /class="(?<cls>[^"]*)"/u.exec(markup)?.groups?.["cls"]?.split(" ") ?? [];

describe("Button selected", () => {
  test("marks the current choice without touching its ARIA state", () => {
    const markup = renderToStaticMarkup(
      <Button aria-pressed selected variant="muted">
        Open
      </Button>,
    );

    expect(markup).toContain('data-pressed=""');
    expect(markup).toContain('aria-pressed="true"');
  });

  test("an unselected button carries no pressed marker", () => {
    const markup = renderToStaticMarkup(
      <Button selected={false} variant="muted">
        Closed
      </Button>,
    );

    expect(markup).not.toContain("data-pressed");
  });

  test.each([
    "ghost",
    "muted",
    "muted-destructive",
    "outline",
    "secondary",
  ] as const)(
    "the %s variant's selected treatment differs from its hover",
    (variant) => {
      const classes = classesOf(
        renderToStaticMarkup(<Button variant={variant}>Option</Button>),
      );
      const selected = classes.filter((cls) => cls.startsWith("data-pressed:"));
      const hover = classes
        .filter((cls) => cls.startsWith("[:hover:not([data-pressed])]:"))
        .map((cls) => cls.replace("[:hover:not([data-pressed])]:", ""));

      expect(selected.length).toBeGreaterThan(0);
      expect(hover.length).toBeGreaterThan(0);
      // Hover never paints a selected button, and selected is not hover's
      // fill alone: it adds an edge or a different surface.
      expect(
        selected
          .map((cls) => cls.replace("data-pressed:", ""))
          .some((cls) => !hover.includes(cls)),
      ).toBe(true);
      expect(
        classes.some((cls) => cls.includes("[:hover,[data-pressed]]")),
      ).toBe(false);
    },
  );
});

describe("Button size inline", () => {
  test("draws no box and takes the type of its line", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <Button size="inline" variant="link">
          show more
        </Button>,
      ),
    );

    expect(classes).toContain("p-0");
    expect(classes).toContain("h-auto");
    expect(classes).toContain("text-[length:inherit]");
    expect(classes).not.toContain("h-9");
    expect(classes.some((cls) => cls.includes("active:scale"))).toBe(false);
  });

  test("sits in the line as an inline box whose text can be copied and wraps", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <Button size="inline" tooltip="Open the cited provision" variant="link">
          § 2 odst. 1 zákona č. 89/2012 Sb., občanský zákoník
        </Button>,
      ),
    );

    expect(classes).toContain("inline");
    expect(classes).not.toContain("inline-flex");
    expect(classes).toContain("select-text");
    expect(classes).not.toContain("select-none");
    expect(classes).toContain("whitespace-normal");
    expect(classes).not.toContain("whitespace-nowrap");
    expect(classes).toContain("focus-visible:ring-2");
  });

  test("keeps its tooltip", () => {
    const markup = renderToStaticMarkup(
      <Button size="inline" tooltip="Open the cited provision" variant="link">
        § 2
      </Button>,
    );

    expect(markup).toContain("data-base-ui-tooltip-trigger");
  });

  test("a quiet inline button paints no hover fill", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <Button size="inline" variant="muted">
          edit
        </Button>,
      ),
    );

    expect(classes).toContain("[:hover:not([data-pressed])]:bg-transparent");
    expect(classes).not.toContain("[:hover:not([data-pressed])]:bg-accent");
  });
});

describe("Button variant plain", () => {
  test("is a box-less target laid out like a native button", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <Button className="w-full" variant="plain">
          <span>Card</span>
        </Button>,
      ),
    );

    expect(classes).toContain("inline-block");
    expect(classes).toContain("text-start");
    expect(classes).toContain("focus-visible:ring-2");
    expect(classes).toContain("rounded-lg");
    expect(classes).toContain("w-full");
    expect(classes).not.toContain("border");
    expect(classes).not.toContain("h-9");
    expect(classes.some((cls) => cls.includes("active:scale"))).toBe(false);
    expect(classes).not.toContain("disabled:opacity-64");
  });

  test("keeps the button's disabled disposition and tooltip", () => {
    const markup = renderToStaticMarkup(
      <Button disabled tooltip="Archived" variant="plain">
        Card
      </Button>,
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("data-base-ui-tooltip-trigger");
  });
});

describe("Button focusRing", () => {
  test("draws the ring inside the box when asked", () => {
    const inside = classesOf(
      renderToStaticMarkup(
        <Button focusRing="inside" variant="plain">
          Thumb
        </Button>,
      ),
    );
    const outside = classesOf(
      renderToStaticMarkup(<Button variant="plain">Thumb</Button>),
    );

    expect(inside).toContain("focus-visible:ring-inset");
    expect(inside).toContain("focus-visible:ring-offset-0");
    expect(inside).not.toContain("focus-visible:ring-offset-1");
    expect(outside).toContain("focus-visible:ring-offset-1");
    expect(outside).not.toContain("focus-visible:ring-inset");
  });
});

describe("Button consolidated additions", () => {
  test("an inline action without a variant is an underlined link", () => {
    const classes = classesOf(
      renderToStaticMarkup(<Button size="inline">retry</Button>),
    );

    expect(classes).toContain("underline");
    expect(classes).not.toContain("bg-primary");
  });

  test("a plain button's ring follows its shape", () => {
    const box = classesOf(
      renderToStaticMarkup(<Button variant="plain">Card</Button>),
    );
    const round = classesOf(
      renderToStaticMarkup(
        <Button shape="round" variant="plain">
          Avatar
        </Button>,
      ),
    );

    expect(box).toContain("rounded-lg");
    expect(round).toContain("rounded-full");
    expect(round).not.toContain("rounded-lg");
  });

  test("icon-2xs is an icon size, named by its tooltip", () => {
    const markup = renderToStaticMarkup(
      <Button
        aria-label="Delete note"
        size="icon-2xs"
        variant="muted-destructive"
      >
        <span />
      </Button>,
    );

    expect(markup).toContain("size-5");
    expect(markup).toContain("data-base-ui-tooltip-trigger");
    expect(markup).toContain("text-muted-foreground");
  });
});
