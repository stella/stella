import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { Dialog, DialogPopup } = await import("@stll/ui/dialog");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { AiRewriteControl } = await import("./ai-rewrite-control");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const instructions = {
  polish:
    "Polish the writing so it is clear and professional while preserving its meaning and language.",
  concise:
    "Make the writing more concise without removing material facts or changing its meaning.",
  clarify:
    "Improve clarity and specificity without inventing facts or changing the meaning.",
  formal:
    "Use a more formal, professional tone while preserving the meaning and language.",
};

const mount = ({
  disabled = false,
  isPending = false,
  dialog = false,
} = {}) => {
  const rewritten: string[] = [];
  const control = (
    <AiRewriteControl
      disabled={disabled}
      isPending={isPending}
      onRewrite={(instruction) => {
        rewritten.push(instruction);
      }}
    />
  );
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <TooltipProvider>
        {dialog ? (
          <Dialog defaultOpen>
            <DialogPopup aria-label="Rewrite form">{control}</DialogPopup>
          </Dialog>
        ) : (
          control
        )}
      </TooltipProvider>
    </IntlProvider>,
  );
  return { view, rewritten };
};

const openOptions = async (view: ReturnType<typeof mount>["view"]) => {
  fireEvent.click(
    view.getByRole("button", { name: messages.ai.chooseRewriteInstruction }),
  );
  const input = await view.findByRole("textbox", {
    name: messages.ai.refinePlaceholder,
  });
  if (!(input instanceof HTMLTextAreaElement)) {
    return panic("Expected the custom instruction textarea");
  }
  return input;
};

test("the primary action applies the default polish instruction once", () => {
  const { view, rewritten } = mount();
  fireEvent.click(view.getByRole("button", { name: messages.ai.editWithAI }));
  expect(rewritten).toEqual([instructions.polish]);
});

for (const { label, instruction } of [
  {
    label: messages.ai.rewritePresets.polish,
    instruction: instructions.polish,
  },
  {
    label: messages.ai.rewritePresets.concise,
    instruction: instructions.concise,
  },
  {
    label: messages.ai.rewritePresets.clarify,
    instruction: instructions.clarify,
  },
  {
    label: messages.ai.rewritePresets.formal,
    instruction: instructions.formal,
  },
]) {
  test(`the ${label} preset applies its instruction once and closes the options`, async () => {
    const { view, rewritten } = mount();
    await openOptions(view);
    fireEvent.click(view.getByRole("button", { name: label }));
    expect(rewritten).toEqual([instruction]);
    await waitFor(() =>
      expect(view.queryByRole("textbox") === null).toBe(true),
    );
  });
}

for (const useMeta of [false, true]) {
  test(`${useMeta ? "Meta" : "Control"} Enter submits the trimmed custom instruction and resets it`, async () => {
    const { view, rewritten } = mount();
    const input = await openOptions(view);
    fireEvent.change(input, {
      target: { value: "  Keep the defined terms.  " },
    });
    fireEvent.keyDown(input, {
      key: "Enter",
      ctrlKey: !useMeta,
      metaKey: useMeta,
    });
    expect(rewritten).toEqual(["Keep the defined terms."]);
    await waitFor(() =>
      expect(view.queryByRole("textbox") === null).toBe(true),
    );
    expect((await openOptions(view)).value).toBe("");
  });
}

for (const pending of [false, true]) {
  test(`${pending ? "pending" : "disabled"} prevents both primary and options actions`, () => {
    const { view, rewritten } = mount({
      disabled: !pending,
      isPending: pending,
    });
    const primary = view.getByRole("button", { name: messages.ai.editWithAI });
    const options = view.getByRole("button", {
      name: messages.ai.chooseRewriteInstruction,
    });
    for (const button of [primary, options]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.tabIndex).toBe(0);
      act(() => {
        button.focus();
      });
      expect(document.activeElement === button).toBe(true);
      fireEvent.pointerDown(button);
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    }
    expect(rewritten).toEqual([]);
    expect(view.queryByRole("textbox") === null).toBe(true);
  });
}

test("custom instructions keep the inherited dialog dirty until discard", async () => {
  const { view, rewritten } = mount({ dialog: true });
  const input = await openOptions(view);
  fireEvent.change(input, { target: { value: "Preserve every reference." } });
  // The nearest Dialog owns dirty confirmation, rather than the options popover.
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect((await view.findByRole("status")).textContent).toContain(
    "Unsaved changes",
  );
  expect(view.getByRole("dialog", { name: "Rewrite form" })).toBeDefined();
  expect(rewritten).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Rewrite form" }) === null).toBe(
      true,
    ),
  );
});
