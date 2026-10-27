import type { Root } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import type { ReferencePeekTarget } from "@stll/decision-reader/reference-peek.logic";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// The peek shell lives in the reader package; it is exercised here, under the
// app's own providers and DOM test run, the way every host mounts it.
// React and Base UI read the DOM when they load, so it exists first.
GlobalRegistrator.register({ url: "http://reader.example.test/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { ReferencePeek } = await import("@stll/decision-reader/reference-peek");
const { holdReferencePeeks } =
  await import("@stll/decision-reader/reference-peek-layering");
const { PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, REFERENCE_PEEK_KINDS } =
  await import("@stll/decision-reader/reference-peek.logic");
const messages = (await import("@/i18n/langs/en.json")).default;

// oxlint-disable-next-line jsx-a11y/anchor-has-content -- a render element; the peek supplies its content
const pageLink = <a href="/law/cze/statutes/synthetic-act" />;

/** One peek of every kind, with a target for every action its kind offers. */
const PEEKS = {
  decision: {
    kind: "decision",
    actions: {
      openInSidePanel: () => undefined,
      openInStella: pageLink,
      openOriginal: "https://publisher.example.test/decision",
    },
  },
  provision: {
    kind: "provision",
    actions: {
      openInSidePanel: () => undefined,
      openInStella: pageLink,
      openOriginal: "https://publisher.example.test/provision",
    },
  },
  statute: {
    kind: "statute",
    actions: { openInSidePanel: () => undefined, openInStella: pageLink },
  },
  unresolvedCitation: { kind: "unresolvedCitation", actions: {} },
} as const satisfies {
  [Kind in ReferencePeekTarget["kind"]]: Extract<
    ReferencePeekTarget,
    { kind: Kind }
  >;
};

const REFERENCE = "SYN 12/2026";
const BODY = "The cited wording.";

let container: HTMLDivElement;
let root: Root;

afterAll(async () => {
  await unregisterDomEnvironment();
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

const mount = async (target: ReferencePeekTarget) => {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <p>
              <ReferencePeek
                body={<span>{BODY}</span>}
                header={{
                  primary: REFERENCE,
                  meta: [
                    { part: "court", text: "Synthetic Supreme Court" },
                    { part: "date", text: "Jan 12, 2026" },
                  ],
                }}
                target={target}
                trigger={{
                  type: "link",
                  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- a render element; the peek supplies its content
                  element: <a href="/reference" />,
                }}
              >
                {REFERENCE}
              </ReferencePeek>
            </p>
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>,
    );
  });
  return (
    container.querySelector<HTMLAnchorElement>('a[href="/reference"]') ??
    panic("The reference was not drawn")
  );
};

/** The open state the reference announces, set the moment the peek opens. */
const isOpen = (trigger: HTMLElement) =>
  trigger.getAttribute("aria-expanded") === "true";

const peek = () =>
  document.body.querySelector<HTMLElement>('[data-slot="reference-peek"]');

/** Lets the popup mount or unmount on real timers. */
const settle = async () => {
  await act(async () => {
    // real-time: Base UI mounts and unmounts the popup on its own timers,
    // which these keyboard tests leave on the real clock.
    await sleep(30);
  });
};

/** Moves fake time on; the popup mounts behind a short timer of its own. */
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

/** A mouse resting on the reference, as a person reading it would. */
const restOn = async (trigger: HTMLElement) => {
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    );
    trigger.dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse" }),
    );
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    trigger.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
};

const leave = async (trigger: HTMLElement, to: Element) => {
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("mouseleave", {
        clientX: 10,
        clientY: 30,
        relatedTarget: to,
      }),
    );
    to.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 40 }),
    );
  });
};

const focus = async (trigger: HTMLElement) => {
  await act(async () => {
    trigger.focus();
  });
  await settle();
};

describe("every kind of peek", () => {
  for (const target of Object.values(PEEKS)) {
    test(`a ${target.kind} peek draws the shared header with its kind's actions`, async () => {
      await focus(await mount(target));
      const shell = peek() ?? panic("Focus did not open the peek");
      const header =
        shell.querySelector<HTMLElement>(
          '[data-slot="reference-peek-header"]',
        ) ?? panic("The peek has no header");
      expect(header.dataset["kind"]).toBe(target.kind);
      expect(
        [...header.querySelectorAll<HTMLElement>(":scope > *")].map(
          (part) => part.dataset["slot"],
        ),
      ).toEqual([
        "reference-peek-kind",
        "reference-peek-summary",
        // A kind with nothing to open draws no empty action group.
        ...(REFERENCE_PEEK_KINDS[target.kind].actions.length === 0
          ? []
          : ["reference-peek-actions"]),
      ]);
      expect(
        header.querySelector('[data-slot="reference-peek-primary"]')
          ?.textContent,
      ).toBe(REFERENCE);
      expect(
        [
          ...header.querySelectorAll<HTMLElement>(
            '[data-slot="reference-peek-meta"]',
          ),
        ].map((part) => part.dataset["part"]),
      ).toEqual(["court", "date"]);
      expect(
        [...header.querySelectorAll<HTMLElement>("[data-peek-action]")].map(
          (action) => action.dataset["peekAction"],
        ),
      ).toEqual([...REFERENCE_PEEK_KINDS[target.kind].actions]);
      const body =
        shell.querySelector('[data-slot="reference-peek-body"]') ??
        panic("The peek has no bounded body");
      expect(body.textContent).toContain(BODY);
    });
  }
});

describe("hover intent", () => {
  test("a peek opens once the pointer has rested on the reference", async () => {
    jest.useFakeTimers();
    const trigger = await mount(PEEKS.decision);
    await restOn(trigger);
    await advance(PEEK_OPEN_DELAY_MS - 1);
    expect(isOpen(trigger)).toBe(false);
    await advance(1);
    expect(isOpen(trigger)).toBe(true);
  });

  test("moving from the reference into the card keeps it open", async () => {
    jest.useFakeTimers();
    const trigger = await mount(PEEKS.decision);
    await restOn(trigger);
    await advance(PEEK_OPEN_DELAY_MS + 50);
    const card = peek() ?? panic("Hover did not open the peek");
    await leave(trigger, card);
    await advance(PEEK_CLOSE_DELAY_MS * 4);
    expect(isOpen(trigger)).toBe(true);
  });

  // The control for the case above: the same exit, not into the card.
  test("moving from the reference elsewhere closes it after the close delay", async () => {
    jest.useFakeTimers();
    const trigger = await mount(PEEKS.decision);
    await restOn(trigger);
    await advance(PEEK_OPEN_DELAY_MS + 50);
    expect(isOpen(trigger)).toBe(true);
    await leave(trigger, document.body);
    await advance(PEEK_CLOSE_DELAY_MS * 4);
    expect(isOpen(trigger)).toBe(false);
  });

  test("Escape closes a peek and returns focus to the reference without reopening it", async () => {
    const trigger = await mount(PEEKS.provision);
    await focus(trigger);
    const action =
      peek()?.querySelector<HTMLElement>("[data-peek-action]") ??
      panic("Focus did not open the peek");
    const escape = async () => {
      await act(async () => {
        (document.activeElement ?? action).dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      await settle();
    };
    await act(async () => {
      action.focus();
    });
    await settle();
    // The focused action shows its tooltip; Escape closes the innermost
    // layer first, the way every nested popup does.
    await escape();
    await escape();
    expect(isOpen(trigger)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("the selection toolbar wins", () => {
  test("no peek opens while a selection toolbar holds them", async () => {
    const trigger = await mount(PEEKS.statute);
    const release = await act(async () => holdReferencePeeks());
    try {
      await restOn(trigger);
      await act(async () => {
        // real-time: the whole open delay passes with the pointer resting,
        // so nothing could still open after it.
        await sleep(PEEK_OPEN_DELAY_MS + 50);
      });
      await focus(trigger);
      await act(async () => {
        trigger.click();
      });
      await settle();
      expect(isOpen(trigger)).toBe(false);
      expect(peek()).toBeNull();
    } finally {
      await act(async () => {
        release();
      });
    }
    await act(async () => {
      trigger.blur();
    });
    await focus(trigger);
    expect(isOpen(trigger)).toBe(true);
  });

  test("an open peek closes when the toolbar appears and stays closed after it goes", async () => {
    const trigger = await mount(PEEKS.provision);
    await focus(trigger);
    expect(isOpen(trigger)).toBe(true);
    const release = await act(async () => holdReferencePeeks());
    await settle();
    expect(isOpen(trigger)).toBe(false);
    await act(async () => {
      release();
    });
    await settle();
    expect(isOpen(trigger)).toBe(false);
  });
});
