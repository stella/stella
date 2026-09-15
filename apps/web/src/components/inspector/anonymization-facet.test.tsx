import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { AnonymizationMatchStatus } from "@/components/inspector/anonymization-match-status";
import messages from "@/i18n/langs/en.json";

const renderStatus = (pipelineStatus: "idle" | "running" | "ready" | "error") =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnonymizationMatchStatus
        matchCount={2}
        pipelineStatus={pipelineStatus}
      />
    </IntlProvider>,
  );

describe("anonymization match status", () => {
  test("shows the failed scan instead of claiming detection is still running", () => {
    const html = renderStatus("error");

    expect(html).toContain("The scan failed. Retry to detect matches.");
    expect(html).not.toContain("Detecting matches in this document…");
  });

  test("distinguishes detection progress from ready match counts", () => {
    expect(renderStatus("idle")).toContain(
      "Detecting matches in this document…",
    );
    expect(renderStatus("running")).toContain(
      "Detecting matches in this document…",
    );
    expect(renderStatus("ready")).toContain(
      "2 matches highlighted in this document.",
    );
  });
});
