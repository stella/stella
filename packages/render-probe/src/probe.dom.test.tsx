import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { installRenderProbe } from "./probe";
import { formatRenderReport } from "./report";

// The probe must be React's DevTools hook before React DOM loads, as in the
// apps; everything React is imported after it.
GlobalRegistrator.register();
const probe = installRenderProbe();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, createContext, memo, use, useState } = await import("react");
const { createRoot } = await import("react-dom/client");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const Theme = createContext("light");

type Item = { id: string; label: string };

const ITEMS: readonly Item[] = [
  { id: "1", label: "a" },
  { id: "2", label: "b" },
  { id: "3", label: "c" },
];

const Header = ({ title }: { title: string }) => <h1>{title}</h1>;

const Row = memo(({ label }: { label: string }) => <li>{label}</li>);
Row.displayName = "Row";

const ThemeReader = () => <span>{use(Theme)}</span>;

const Boundary = memo(() => <ThemeReader />);
Boundary.displayName = "Boundary";

const App = () => {
  const [count, updateCount] = useState(0);
  const [items, updateItems] = useState(ITEMS);
  const [theme, updateTheme] = useState("light");
  return (
    <Theme value={theme}>
      <Header title="Matters" />
      <p>{count}</p>
      <button
        id="count"
        type="button"
        onClick={() => {
          updateCount((previous) => previous + 1);
        }}
      />
      <button
        id="capitalize"
        type="button"
        onClick={() => {
          updateItems((previous) =>
            previous.map((item) => ({
              ...item,
              label: item.label.toUpperCase(),
            })),
          );
        }}
      />
      <button
        id="capitalize-second"
        type="button"
        onClick={() => {
          updateItems((previous) =>
            previous.map((item) =>
              item.id === "2"
                ? { ...item, label: item.label.toUpperCase() }
                : item,
            ),
          );
        }}
      />
      <button
        id="dark"
        type="button"
        onClick={() => {
          updateTheme("dark");
        }}
      />
      <ul>
        {items.map((item) => (
          <Row key={item.id} label={item.label} />
        ))}
      </ul>
      <Boundary />
    </Theme>
  );
};

const click = async (id: string) => {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`#${id}`)?.click();
    await Promise.resolve();
  });
};

const renders = () =>
  Object.fromEntries(
    Object.entries(probe.snapshot().components).map(([name, entry]) => [
      name,
      Object.fromEntries(
        Object.entries(entry.causes).filter(([, count]) => count > 0),
      ),
    ]),
  );

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe("the render probe", () => {
  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    probe.reset();
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  test("counts each component of a mounted tree once, as a mount", async () => {
    expect(renders()).toEqual({
      App: { mount: 1 },
      Header: { mount: 1 },
      Row: { mount: 3 },
      Boundary: { mount: 1 },
      ThemeReader: { mount: 1 },
    });
    expect(probe.snapshot().widestCommit).toBe(7);
  });

  test("a parent's own state change renders it and its unmemoized children, never the memoized ones", async () => {
    probe.reset();
    await click("count");
    // Rows and the boundary bailed out: their stale flags must not count.
    expect(renders()).toEqual({
      App: { state: 1 },
      Header: { parent: 1 },
    });
    expect(probe.snapshot().widestCommit).toBe(2);
  });

  test("a changed prop renders only the row it reached", async () => {
    probe.reset();
    await click("capitalize-second");
    expect(renders()).toEqual({
      App: { state: 1 },
      Header: { parent: 1 },
      Row: { props: 1 },
    });
  });

  test("a context change reaches its reader through a memo boundary that bailed out", async () => {
    probe.reset();
    await click("dark");
    expect(renders()).toEqual({
      App: { state: 1 },
      Header: { parent: 1 },
      ThemeReader: { context: 1 },
    });
  });

  test("a commit after earlier renders counts only its own", async () => {
    probe.reset();
    await click("count");
    await click("count");
    expect(probe.snapshot()).toMatchObject({
      commits: 2,
      renders: 4,
      widestCommit: 2,
    });
  });

  test("the report names the widest renderers first", async () => {
    probe.reset();
    await click("capitalize");
    const report = formatRenderReport(probe.snapshot());
    expect(report.split("\n")[0]).toBe(
      "1 commits, 5 component renders, widest commit 5, 1 with unchanged props",
    );
    expect(report.split("\n")[2]).toStartWith("Row");
  });

  test("a Refresh-style hook wrapper retains renderer registration and commit counting", async () => {
    const hook: unknown = Reflect.get(
      globalThis,
      "__REACT_DEVTOOLS_GLOBAL_HOOK__",
    );
    if (typeof hook !== "object" || hook === null) {
      throw new TypeError("The probe must install a DevTools hook");
    }
    const renderers: unknown = Reflect.get(hook, "renderers");
    expect(renderers instanceof Map).toBe(true);
    if (!(renderers instanceof Map)) {
      throw new TypeError("Refresh requires a renderer map");
    }
    expect(renderers.size).toBeGreaterThan(0);
    const previousCommit: unknown = Reflect.get(hook, "onCommitFiberRoot");
    if (typeof previousCommit !== "function") {
      throw new TypeError("The probe must install a commit callback");
    }
    let refreshCommits = 0;
    Reflect.set(hook, "onCommitFiberRoot", (...args: unknown[]) => {
      refreshCommits += 1;
      Reflect.apply(previousCommit, hook, args);
    });
    probe.reset();
    try {
      await click("count");
      expect(refreshCommits).toBe(1);
      expect(renders()).toEqual({ App: { state: 1 }, Header: { parent: 1 } });
      expect(Reflect.get(hook, "renderers")).toBe(renderers);
    } finally {
      Reflect.set(hook, "onCommitFiberRoot", previousCommit);
    }
  });
});
