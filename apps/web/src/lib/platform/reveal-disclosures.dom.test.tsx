import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });

const { act, useState } = await import("react");
const { cleanup, render, screen } = await import("@testing-library/react");
// Base UI disables when it loads before a DOM exists: import after register.
const { Collapsible, CollapsiblePanel, CollapsibleTrigger } =
  await import("@stll/ui/collapsible");
const { revealEnclosingDisclosures } =
  await import("@/lib/platform/reveal-disclosures");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const CC_LINE = "Cc: Eliška Dvořáková";

const ControlledParticipants = ({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
      open={open}
    >
      <CollapsibleTrigger>{open ? "Hide" : "Show"}</CollapsibleTrigger>
      <CollapsiblePanel>
        <span data-testid="cc">{CC_LINE}</span>
      </CollapsiblePanel>
    </Collapsible>
  );
};

describe("revealEnclosingDisclosures", () => {
  test("opens every closed details element around the target", () => {
    const host = document.createElement("div");
    // safe-html: constant markup
    host.innerHTML =
      "<details><summary>a</summary><details><summary>b</summary><p>x</p></details></details>";
    document.body.append(host);
    const target = host.querySelector("p");
    if (!target) {
      throw new Error("expected the paragraph");
    }

    revealEnclosingDisclosures(target);

    const opened = [...host.querySelectorAll("details")].map((details) =>
      details.hasAttribute("open"),
    );
    expect(opened).toEqual([true, true]);
    host.remove();
  });

  test("a closed controlled Collapsible opens through its own state", async () => {
    const changes: boolean[] = [];
    render(
      <ControlledParticipants
        onOpenChange={(open) => {
          changes.push(open);
        }}
      />,
    );
    const target = screen.getByTestId("cc");
    expect(target.closest('[hidden="until-found"]')).not.toBeNull();

    await act(async () => {
      revealEnclosingDisclosures(target);
    });

    expect(changes).toEqual([true]);
    expect(target.closest("[hidden]")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide" })).toBeDefined();
  });

  test("an element outside any disclosure is left as it is", () => {
    const paragraph = document.createElement("p");
    document.body.append(paragraph);
    const events: string[] = [];
    paragraph.addEventListener("beforematch", () => {
      events.push("beforematch");
    });

    revealEnclosingDisclosures(paragraph);

    expect(events).toEqual([]);
    expect(paragraph.hasAttribute("hidden")).toBe(false);
    paragraph.remove();
  });
});

// Source-text guard: unfolding a disclosure for navigation, find or landing
// goes through the one helper, so @stll/ui panels are never skipped again.
const WEB_SOURCE = nodePath.join(import.meta.dirname, "..", "..");
const OWNER = nodePath.join(import.meta.dirname, "reveal-disclosures.ts");
const DIRECT_OPEN =
  /\.open\s*=\s*true|setAttribute\(\s*["']open["']|closest\(\s*["']details["']/u;

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/u.test(entry.name)
      ? [path]
      : [];
  });

test("only the reveal helper opens a disclosure directly", () => {
  const offenders = listSourceFiles(WEB_SOURCE)
    .filter((path) => path !== OWNER)
    .filter((path) => DIRECT_OPEN.test(readFileSync(path, "utf-8")))
    .map((path) => repoRelativePath(WEB_SOURCE, path));

  expect(offenders).toEqual([]);
});
