import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { InlineEdit } = await import("@/components/inline-edit");
const { fileExtensionSuffix } =
  await import("@/components/file-extension-suffix");

type Outcome = "commit" | "cancel";

const mount = (action?: React.ReactNode) => {
  const outcomes: Outcome[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <InlineEdit
        action={action}
        onCancel={() => {
          outcomes.push("cancel");
        }}
        onChange={() => undefined}
        onCommit={() => {
          outcomes.push("commit");
        }}
        suffix={fileExtensionSuffix("Engagement letter.docx")}
        value="Engagement letter"
      />
    </IntlProvider>,
  );
  const field = screen.getByRole("textbox", { name: messages.common.rename });
  return { field, outcomes };
};

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

describe("inline rename", () => {
  // Every inline rename commits from the keyboard or on blur, like
  // InlineRenameInput; a commit button of its own crowds narrow rows.
  test("renders no button of its own", () => {
    mount();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("renders only the caller's action button", () => {
    mount(<button aria-label={messages.common.edit} type="button" />);
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([messages.common.edit]);
  });

  test("asks touch keyboards for a Done key", () => {
    const { field } = mount();
    expect(field.getAttribute("enterkeyhint")).toBe("done");
  });

  test("Enter commits, Escape cancels and leaving the field commits", () => {
    const enter = mount();
    fireEvent.keyDown(enter.field, { key: "Enter" });
    expect(enter.outcomes).toEqual(["commit"]);
    cleanup();

    const escape = mount();
    fireEvent.keyDown(escape.field, { key: "Escape" });
    expect(escape.outcomes).toEqual(["cancel"]);
    cleanup();

    const blur = mount();
    act(() => blur.field.blur());
    expect(blur.outcomes).toEqual(["commit"]);
  });
});
