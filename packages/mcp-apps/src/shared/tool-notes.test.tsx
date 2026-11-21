import { render } from "@testing-library/react";
import { expect, test } from "bun:test";

import { ToolNotes } from "./tool-notes";

test("tool notes render only messages explicitly addressed to the user", () => {
  const ui = render(
    <ToolNotes
      notes={[
        { audience: "agent", message: "Pass strict: true." },
        { audience: "user", message: "User notice" },
        { audience: "user", message: "User notice" },
        { audience: "agent", message: "Use the next cursor." },
      ]}
    />,
  );
  expect(
    ui.getAllByRole("status").map(({ textContent }) => textContent),
  ).toEqual(["User notice"]);
  expect(ui.container.textContent).not.toContain("Pass strict: true.");
  expect(ui.container.textContent).not.toContain("Use the next cursor.");
});

test("an entirely agent-directed result leaves no note surface", () => {
  const ui = render(
    <ToolNotes
      notes={[{ audience: "agent", message: "Call another tool." }]}
    />,
  );
  expect(ui.container.innerHTML).toBe("");
});
