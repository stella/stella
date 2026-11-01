import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge/tools/x" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ToolMarkdown } =
  await import("@/features/knowledge/public/tools/tool-markdown");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

describe("ToolMarkdown", () => {
  test("its first commit is rendered markdown, not raw source", () => {
    const { container } = render(
      <IntlProvider locale="en" messages={messages}>
        <ToolMarkdown markdown={"# Skill title\n\nBody text."} />
      </IntlProvider>,
    );

    expect(container.querySelector("h1")?.textContent).toBe("Skill title");
    expect(container.textContent).not.toContain("# Skill title");
  });
});
