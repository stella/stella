import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Button, BUTTON_CONTENT, BUTTON_SIZE_CONTENT } from "./button";
import { Dialog, DialogClose, DialogTrigger } from "./dialog";
import { Menu, MenuTrigger } from "./menu";
import { Popover, PopoverTrigger } from "./popover";
import { Sheet, SheetClose, SheetTrigger } from "./sheet";

// `disabled=""` is what React emits for the native attribute; a button that
// carries it can never be hovered or focused, so its tooltip can never open.
const isNativelyDisabled = (markup: string) => / disabled=""/u.test(markup);
const isAccessiblyDisabled = (markup: string) =>
  markup.includes('aria-disabled="true"');
// Base UI marks the element a mounted tooltip is attached to.
const hasTooltip = (markup: string) =>
  markup.includes("data-base-ui-tooltip-trigger");

const SIZES = Object.keys(BUTTON_SIZE_CONTENT).filter(
  (size): size is keyof typeof BUTTON_SIZE_CONTENT =>
    size in BUTTON_SIZE_CONTENT,
);

// What a caller can name a button with besides an explicit `tooltip`.
const ACCESSIBLE_NAMES = [
  { "aria-label": "Go to the reasoning" },
  { title: "Go to the reasoning" },
] as const;

describe("Button implicit tooltip", () => {
  test.each(SIZES)(
    "%s: the accessible name becomes a tooltip only at an icon size",
    (size) => {
      const isIconSize = BUTTON_SIZE_CONTENT[size] === BUTTON_CONTENT.icon;
      for (const name of ACCESSIBLE_NAMES) {
        expect(
          hasTooltip(
            renderToStaticMarkup(
              <Button {...name} size={size}>
                Reasoning
              </Button>,
            ),
          ),
        ).toBe(isIconSize);
        // The disposition reads the same rule, so a disabled text button
        // with a label stays natively disabled.
        expect(
          isAccessiblyDisabled(
            renderToStaticMarkup(
              <Button {...name} disabled size={size}>
                Reasoning
              </Button>,
            ),
          ),
        ).toBe(isIconSize);
      }
    },
  );

  test("an unsized button is a text button", () => {
    expect(
      hasTooltip(
        renderToStaticMarkup(
          <Button aria-label="Go to the reasoning">Reasoning</Button>,
        ),
      ),
    ).toBe(false);
  });

  test("a touch button retains its label and native disabled state", () => {
    for (const name of ACCESSIBLE_NAMES) {
      const markup = renderToStaticMarkup(
        <Button {...name} disabled size="touch">
          Reasoning
        </Button>,
      );
      expect(markup).toContain("Reasoning");
      expect(markup).toContain("min-h-[44px]");
      expect(markup).toContain("min-w-[44px]");
      expect(isNativelyDisabled(markup)).toBe(true);
      expect(hasTooltip(markup)).toBe(false);
    }
  });

  test.each(SIZES)("%s: an explicit tooltip renders", (size) => {
    expect(
      hasTooltip(
        renderToStaticMarkup(
          <Button size={size} tooltip="Opens the reasoning">
            Reasoning
          </Button>,
        ),
      ),
    ).toBe(true);
  });

  test("tooltip={false} suppresses an icon button's tooltip", () => {
    expect(
      hasTooltip(
        renderToStaticMarkup(
          <Button aria-label="Close" size="icon" tooltip={false} />,
        ),
      ),
    ).toBe(false);
  });
});

type TriggerProps = {
  "aria-label"?: string;
  children?: ReactNode;
  render?: ReactElement;
  tooltip?: ReactNode;
};

const OVERLAY_TRIGGERS = {
  AlertDialogClose: (props: TriggerProps) => (
    <AlertDialog>
      <AlertDialogClose {...props} />
    </AlertDialog>
  ),
  AlertDialogTrigger: (props: TriggerProps) => (
    <AlertDialog>
      <AlertDialogTrigger {...props} />
    </AlertDialog>
  ),
  DialogClose: (props: TriggerProps) => (
    <Dialog>
      <DialogClose {...props} />
    </Dialog>
  ),
  DialogTrigger: (props: TriggerProps) => (
    <Dialog>
      <DialogTrigger {...props} />
    </Dialog>
  ),
  MenuTrigger: (props: TriggerProps) => (
    <Menu>
      <MenuTrigger {...props} />
    </Menu>
  ),
  PopoverTrigger: (props: TriggerProps) => (
    <Popover>
      <PopoverTrigger {...props} />
    </Popover>
  ),
  SheetClose: (props: TriggerProps) => (
    <Sheet>
      <SheetClose {...props} />
    </Sheet>
  ),
  SheetTrigger: (props: TriggerProps) => (
    <Sheet>
      <SheetTrigger {...props} />
    </Sheet>
  ),
};

const TRIGGER_NAMES = Object.keys(OVERLAY_TRIGGERS).filter(
  (name): name is keyof typeof OVERLAY_TRIGGERS => name in OVERLAY_TRIGGERS,
);

describe("overlay trigger tooltip", () => {
  test.each(TRIGGER_NAMES)(
    "%s derives no tooltip from its own label",
    (name) => {
      const Trigger = OVERLAY_TRIGGERS[name];
      expect(
        hasTooltip(
          renderToStaticMarkup(
            <Trigger aria-label="Open the outline">Outline</Trigger>,
          ),
        ),
      ).toBe(false);
      expect(
        hasTooltip(
          renderToStaticMarkup(
            <Trigger
              aria-label="Open the outline"
              render={<Button size="sm" />}
            >
              Outline
            </Trigger>,
          ),
        ),
      ).toBe(false);
    },
  );

  test.each(TRIGGER_NAMES)(
    "%s rendered as an icon Button hands it the label",
    (name) => {
      const Trigger = OVERLAY_TRIGGERS[name];
      expect(
        hasTooltip(
          renderToStaticMarkup(
            <Trigger aria-label="Add" render={<Button size="icon" />} />,
          ),
        ),
      ).toBe(true);
    },
  );

  test.each(TRIGGER_NAMES)("%s still mounts an explicit tooltip", (name) => {
    const Trigger = OVERLAY_TRIGGERS[name];
    expect(
      hasTooltip(
        renderToStaticMarkup(<Trigger tooltip="Outline">Outline</Trigger>),
      ),
    ).toBe(true);
  });
});

describe("Button disabled disposition", () => {
  test("a disabled button with no tooltip keeps the native attribute", () => {
    const markup = renderToStaticMarkup(<Button disabled>Save</Button>);

    expect(isNativelyDisabled(markup)).toBe(true);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });

  test("a disabled button with a tooltip stays reachable instead", () => {
    const markup = renderToStaticMarkup(
      <Button disabled tooltip="Save the draft first">
        Approve
      </Button>,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
    // Disabled still reads as disabled to a sighted user.
    expect(markup).toContain("opacity-64");
    expect(markup).toContain("cursor-not-allowed");
  });

  test("an aria-label is a tooltip too, so it takes the same path", () => {
    const markup = renderToStaticMarkup(
      <Button aria-label="Suggest a title" disabled size="icon-xs" />,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
  });

  test("a suppressed tooltip leaves the button natively disabled", () => {
    const markup = renderToStaticMarkup(
      <Button aria-label="Approve" disabled size="icon" tooltip={false} />,
    );

    expect(isNativelyDisabled(markup)).toBe(true);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });

  test("loading disables the same way", () => {
    const markup = renderToStaticMarkup(
      <Button loading tooltip="Saving">
        Save
      </Button>,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
  });

  test("an enabled button is disabled by neither mechanism", () => {
    const markup = renderToStaticMarkup(<Button tooltip="Save">Save</Button>);

    expect(isNativelyDisabled(markup)).toBe(false);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });
});

describe("Button loading icon", () => {
  const RetryIcon = () => <svg data-testid="retry-icon" />;

  // A retry button carries its own icon; while it loads, the loader must be
  // the only icon a reader sees, not a second spinner beside the first.
  test("the loader stands in for the caller's icon while loading", () => {
    const markup = renderToStaticMarkup(
      <Button icon={<RetryIcon />} loading>
        <span>Try again</span>
      </Button>,
    );

    expect(markup).toContain('data-slot="button-loader"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("animate-spin");
    expect(markup.match(/<svg/gu)).toHaveLength(1);
    expect(markup).not.toContain('data-testid="retry-icon"');
    expect(markup).toContain("<span>Try again</span>");
  });

  test("the caller's icon shows once the button is idle", () => {
    const markup = renderToStaticMarkup(
      <Button icon={<RetryIcon />}>Try again</Button>,
    );

    expect(markup).toContain('data-testid="retry-icon"');
    expect(markup).not.toContain("button-loader");
  });
});

describe("Button press feedback", () => {
  const PRESS = "motion-safe:active:scale-[0.98]";

  test("an enabled button gives under the pointer, icon buttons included", () => {
    for (const markup of [
      renderToStaticMarkup(<Button>Save</Button>),
      renderToStaticMarkup(<Button aria-label="Close" size="icon" />),
      renderToStaticMarkup(<Button variant="ghost">Cancel</Button>),
    ]) {
      expect(markup).toContain(PRESS);
      expect(markup).toContain("transition-transform");
      expect(markup).toContain("select-none");
    }
  });

  test("a button that cannot act never appears to respond", () => {
    for (const markup of [
      renderToStaticMarkup(<Button disabled>Save</Button>),
      renderToStaticMarkup(
        <Button disabled tooltip="Save the draft first">
          Approve
        </Button>,
      ),
      renderToStaticMarkup(<Button loading>Save</Button>),
    ]) {
      expect(markup).not.toContain(PRESS);
    }
  });

  test("menu rows and link-styled buttons keep their surface's treatment", () => {
    expect(
      renderToStaticMarkup(<Button size="row">Rename</Button>),
    ).not.toContain(PRESS);
    expect(
      renderToStaticMarkup(<Button variant="link">Learn more</Button>),
    ).not.toContain(PRESS);
  });
});
