import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";

import type { ToolCallCodeTone } from "./tool-call-code-block";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ToolCallCodeBlock } = await import("./tool-call-code-block");

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const mount = (tone: ToolCallCodeTone) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <ToolCallCodeBlock
        code={'{\n  "query": "nájemní smlouva"\n}'}
        label="Input"
        language="json"
        tone={tone}
      />
    </IntlProvider>,
  );

describe("ToolCallCodeBlock", () => {
  test("names the block for assistive tech without a visible label or card", () => {
    const { container } = mount("call");

    const region = screen.getByRole("region", { name: "Input" });
    expect(region.textContent).toContain('"query": "nájemní smlouva"');
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

  test("keeps the copy action", () => {
    mount("result");

    expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
  });
});
