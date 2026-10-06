import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import arabicMessages from "@/i18n/langs/ar.json" with { type: "json" };
import messages from "@/i18n/langs/en.json" with { type: "json" };

import type { ToolCallCodeTone } from "./tool-call-code-block";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { ToolCallCodeBlock } = await import("./tool-call-code-block");

afterEach(() => {
  cleanup();
  mock.restore();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const mount = (tone: ToolCallCodeTone, lineNumbers = false) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <ToolCallCodeBlock
        code={'{\n  "query": "nájemní smlouva"\n}'}
        label="Input"
        language="json"
        lineNumbers={lineNumbers}
        tone={tone}
      />
    </IntlProvider>,
  );

describe("ToolCallCodeBlock", () => {
  test("names the block for assistive tech without a visible label or card", () => {
    const { container } = mount("call");

    const region = screen.getByRole("region", { name: "Input" });
    expect(region.textContent).toContain('"query": "nájemní smlouva"');
    expect(region.getAttribute("dir")).toBe("ltr");
    expect(region.className).not.toContain("border");
    expect(region.className).not.toContain("bg-");
    expect(container.textContent).not.toContain("json");
  });

  test("renders the call in the foreground", () => {
    const { container } = mount("call");

    expect(container.querySelector("pre")?.className).not.toContain("opacity-");
  });

  test("mutes the result", () => {
    const { container } = mount("result");

    expect(container.querySelector("pre")?.className).toContain("opacity-60");
  });

  test("renders source line numbers without changing the code", () => {
    render(
      <IntlProvider locale="en" messages={messages}>
        <ToolCallCodeBlock
          code={"const answer = 42;\nreturn answer;"}
          label="Source code"
          language="typescript"
          lineNumbers
          tone="call"
        />
      </IntlProvider>,
    );

    const region = screen.getByRole("region", { name: "Source code" });
    expect(region.textContent).toContain("const answer = 42;");
    expect(region.textContent).toContain("return answer;");
    expect(region.querySelectorAll("[data-chat-copy-exclude]").length).toBe(3);
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });

  test("localizes the copy action in Arabic", () => {
    render(
      <IntlProvider locale="ar" messages={arabicMessages}>
        <ToolCallCodeBlock
          code="No matches"
          label={arabicMessages.chat.toolCall.output}
          language="text"
          tone="result"
        />
      </IntlProvider>,
    );

    expect(
      screen.getByRole("region", { name: arabicMessages.chat.toolCall.output })
        .textContent,
    ).toContain("No matches");
    expect(
      screen.getByRole("button", { name: arabicMessages.common.copy }),
    ).toBeDefined();
  });

  test("copies the complete source without line numbers or labels", async () => {
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const toast = spyOn(stellaToast, "add").mockReturnValue("copied");
    mount("result", true);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: messages.common.copied,
        type: "success",
      }),
    );
    expect(write).toHaveBeenCalledWith('{\n  "query": "nájemní smlouva"\n}');
  });

  test("shows a failure when clipboard access is denied", async () => {
    spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard denied", "NotAllowedError"),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("denied");
    mount("call");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });
});
