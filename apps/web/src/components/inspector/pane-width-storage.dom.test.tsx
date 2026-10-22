import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { INSPECTOR_PANE_DEFAULT_WIDTH, INSPECTOR_PANE_KEYBOARD_STEP } =
  await import("@stll/ui/inspector");
const {
  INSPECTOR_PANE_WIDTH_STORAGE_KEY,
  migrateInspectorPaneWidth,
  useSharedInspectorPaneWidth,
} = await import("@/components/inspector/pane-width-storage");
const { deviceStorage } = await import("@/lib/account/browser-storage");

const storage = deviceStorage("local");

type Surface = Parameters<typeof migrateInspectorPaneWidth>[0];

const LEGACY_MATTER_KEY = "stella:inspector-pane-width:v1:matter";
const LEGACY_PUBLIC_LAW_KEY = "stella:inspector-pane-width:v1:public-law";

// A dock as each section mounts it: the matter shell and the public law
// reader render this same hook, and nothing else.
const Dock = ({ openedFrom }: { openedFrom: Surface }) => {
  const { resizeHandleProps, width } = useSharedInspectorPaneWidth({
    openedFrom,
    sidebarWidth: 240,
    viewportWidth: 1920,
  });
  return (
    <div data-width={width} role="separator" {...resizeHandleProps}>
      {openedFrom}
    </div>
  );
};

beforeEach(() => {
  for (const key of [
    INSPECTOR_PANE_WIDTH_STORAGE_KEY,
    LEGACY_MATTER_KEY,
    LEGACY_PUBLIC_LAW_KEY,
  ]) {
    storage.removeItem(key);
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("one inspector width across sections", () => {
  test("a width dragged in matters is the width case law opens at, and back", () => {
    const grown =
      INSPECTOR_PANE_DEFAULT_WIDTH + 2 * INSPECTOR_PANE_KEYBOARD_STEP;

    const matters = render(<Dock openedFrom="matter" />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      String(grown),
    );
    matters.unmount();

    const caseLaw = render(<Dock openedFrom="public-law" />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      String(grown),
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    caseLaw.unmount();

    render(<Dock openedFrom="matter" />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      String(grown - INSPECTOR_PANE_KEYBOARD_STEP),
    );
  });
});

describe("migrateInspectorPaneWidth", () => {
  test("the section opened first keeps its earlier width and the old keys go", () => {
    storage.setItem(LEGACY_MATTER_KEY, "520");
    storage.setItem(LEGACY_PUBLIC_LAW_KEY, "610");

    migrateInspectorPaneWidth("public-law");

    expect(storage.getItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY)).toBe("610");
    expect(storage.getItem(LEGACY_MATTER_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_PUBLIC_LAW_KEY)).toBeNull();
  });

  test("falls back to the other section's earlier width", () => {
    storage.setItem(LEGACY_PUBLIC_LAW_KEY, "610");

    migrateInspectorPaneWidth("matter");

    expect(storage.getItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY)).toBe("610");
  });

  test("a shared width already stored is never overwritten", () => {
    storage.setItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY, "480");
    storage.setItem(LEGACY_MATTER_KEY, "520");

    migrateInspectorPaneWidth("matter");

    expect(storage.getItem(INSPECTOR_PANE_WIDTH_STORAGE_KEY)).toBe("480");
    expect(storage.getItem(LEGACY_MATTER_KEY)).toBeNull();
  });

  test("a dock mounted on migrated storage opens at the migrated width", () => {
    storage.setItem(LEGACY_MATTER_KEY, "520");

    render(<Dock openedFrom="matter" />);

    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      "520",
    );
  });
});

// A second key, or a dock calling the width hook with its own key, would bring
// back a width per section. Only the owner module may do either.
test("no source outside the owner keeps an inspector width of its own", async () => {
  const webRoot = nodePath.resolve(import.meta.dir, "../../..");
  const allowed = new Set([
    "src/components/inspector/pane-width-storage.ts",
    // The device storage registry names the key's prefix, not a second key.
    "src/lib/account/storage-families.ts",
  ]);
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(webRoot)) {
    if (allowed.has(file) || file.includes(".test.")) {
      continue;
    }
    const source = readFileSync(nodePath.join(webRoot, file), "utf-8");
    if (
      source.includes("inspector-pane-width:") ||
      /\buseInspectorPaneWidth\b/u.test(source)
    ) {
      offenders.push(file);
    }
  }

  expect(offenders).toEqual([]);
});
