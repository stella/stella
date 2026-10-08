import { expect, mock, test } from "bun:test";

import { createVisualThemeHandler } from "./guest-theme";

test("guest applies only validated theme updates from its captured parent", () => {
  const parentWindow = {};
  const onTheme = mock(() => undefined);
  const receive = createVisualThemeHandler({ parentWindow, onTheme });
  const theme = { appearance: "dark", variables: { "--foreground": "white" } };
  const data = { kind: "theme", theme };
  for (const event of [
    { source: {}, data },
    { source: null, data },
    { source: parentWindow, data: null },
    {
      source: parentWindow,
      data: {
        ...data,
        theme: {
          ...theme,
          variables: { "--foreground": "url(https://example.test)" },
        },
      },
    },
    {
      source: parentWindow,
      data: { ...data, theme: { ...theme, variables: { "--other": "white" } } },
    },
    { source: parentWindow, data: { ...data, extra: true } },
  ]) {
    receive(event);
  }
  expect(onTheme).not.toHaveBeenCalled();
  receive({ source: parentWindow, data });
  expect(onTheme.mock.calls).toEqual([[theme]]);
});
