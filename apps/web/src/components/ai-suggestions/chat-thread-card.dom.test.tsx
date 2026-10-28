import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const React = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const messages = (await import("@/i18n/langs/en.json")).default;
const { DockedChatStackProvider } =
  await import("@/components/chat/docked-chat-stack");
const { DockedComposer } = await import("@/components/chat/docked-composer");
const { ChatThreadCard } = await import("./host");

const READER_TEXT = "§ 3a Strop podpory se uplatní na projekty";
const ANSWER_TEXT = "Answer about the support cap";

const portals: HTMLElement[] = [];

afterEach(() => {
  cleanup();
  for (const portal of portals.splice(0)) {
    portal.remove();
  }
});
afterAll(unregisterDomEnvironment);

/**
 * A reader with the document chat floating over it: the reader text, the
 * composer column (composer and the open thread card), and a menu portalled
 * beside the app root the way popups mount.
 */
const renderOpenThread = () => {
  const collapses: string[] = [];
  const Host = () => {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    return (
      <IntlProvider locale="en" messages={messages}>
        <TooltipProvider>
          <DockedChatStackProvider>
            <p>{READER_TEXT}</p>
            <DockedComposer bar={<textarea aria-label="Message" dir="ltr" />} />
            <ChatThreadCard
              onCollapse={() => {
                collapses.push("collapse");
              }}
              scrollRef={scrollRef}
            >
              <p>{ANSWER_TEXT}</p>
            </ChatThreadCard>
          </DockedChatStackProvider>
        </TooltipProvider>
      </IntlProvider>
    );
  };
  const view = render(<Host />);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.textContent = "Model";
  document.body.append(menu);
  portals.push(menu);
  return {
    collapses,
    cue: () =>
      view.container.ownerDocument.querySelector("[data-collapse-cue]"),
    menu,
    view,
  };
};

const press = (target: Element) => {
  fireEvent.pointerDown(target, { button: 0 });
};

test("a press on the reader text flashes the collapse control and keeps the card open", () => {
  const { collapses, cue, view } = renderOpenThread();
  expect(cue()).toBeNull();

  press(view.getByText(READER_TEXT));

  const flash = cue();
  expect(flash).not.toBeNull();
  expect(flash?.className).toContain("animate-attention-flash-twice");
  expect(
    view.getByRole("dialog", { name: messages.chat.aiThread }),
  ).toBeTruthy();
  expect(collapses).toEqual([]);
  // The flash sits on the control that closes the card.
  expect(
    flash?.parentElement?.querySelector(
      `button[aria-label="${messages.chat.hideThread}"]`,
    ),
  ).not.toBeNull();
});

test("each press on the reader restarts the flash", () => {
  const { cue, view } = renderOpenThread();
  const text = view.getByText(READER_TEXT);

  press(text);
  const first = cue();
  press(text);

  expect(cue()).not.toBeNull();
  expect(cue()).not.toBe(first);
});

test("with reduced motion the flash holds still instead of fading", () => {
  const { cue, view } = renderOpenThread();

  press(view.getByText(READER_TEXT));

  expect(cue()?.className).toContain("motion-reduce:animate-none");
  expect(cue()?.className).toContain("motion-reduce:opacity-100");
});

test("presses on the chat itself or on a popup do not flash", () => {
  const { cue, menu, view } = renderOpenThread();

  press(view.getByRole("textbox", { name: "Message" }));
  press(view.getByText(ANSWER_TEXT));
  press(menu);
  fireEvent.pointerDown(view.getByText(READER_TEXT), { button: 2 });

  expect(cue()).toBeNull();
});
