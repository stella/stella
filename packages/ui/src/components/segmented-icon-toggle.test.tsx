import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { SegmentedIconToggle } from "./segmented-icon-toggle";

const Icon = () => <span />;

describe("SegmentedIconToggle", () => {
  test("exposes stable option values independently of translated labels", () => {
    const markup = renderToStaticMarkup(
      <SegmentedIconToggle
        onChange={() => undefined}
        options={[
          { value: "compact", icon: Icon, label: "Compact rows" },
          { value: "comfortable", icon: Icon, label: "Comfortable rows" },
        ]}
        value="compact"
      />,
    );

    expect(markup).toContain('data-slot="segmented-icon-toggle"');
    expect(markup).toContain('data-control-value="compact"');
    expect(markup).toContain('data-control-value="comfortable"');
  });
});
