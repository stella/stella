// Passive regression fixture for
// `no-dom-node-poll-assertion/no-dom-node-poll-assertion`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { expect } from "bun:test";

import { screen, waitFor } from "@testing-library/react";

// --- Flagged: a matcher that formats the node when the poll fails ---
export const waitsOnNodes = async () => {
  await waitFor(() =>
    // oxlint-disable-next-line no-dom-node-poll-assertion/no-dom-node-poll-assertion
    expect(screen.queryByText("Saved")).toBeNull(),
  );
  await waitFor(() =>
    // oxlint-disable-next-line no-dom-node-poll-assertion/no-dom-node-poll-assertion
    expect(screen.getByRole("switch")).not.toBeTruthy(),
  );
  await waitFor(() =>
    // oxlint-disable-next-line no-dom-node-poll-assertion/no-dom-node-poll-assertion
    expect(document.querySelectorAll("li")).toHaveLength(2),
  );
};

// --- Allowed: booleans, strings and numbers, and a throwing presence check ---
export const waitsOnValues = async () => {
  // expect-clean: no-dom-node-poll-assertion/no-dom-node-poll-assertion
  await waitFor(() =>
    expect(screen.queryByText("Saved") === null).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    ),
  );
  await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("li").length).toBe(2));
  // Outside a polled wait a failing matcher formats the node once.
  expect(screen.queryByText("Saved")).toBeNull();
};
