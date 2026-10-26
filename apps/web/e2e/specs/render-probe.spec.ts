import type { Frame } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sleep } from "@stll/concurrency/sleep";

import { installRenderProbe, measureAction } from "../helpers/render-probe";
import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

test("the injected probe counts the same known component across three app loads", async ({
  context,
  page,
}) => {
  test.skip(
    !EXPECTS_DEV_RUNTIME,
    "The probe measures the development renderer.",
  );
  await installRenderProbe(context);
  await page.goto("/dev?visual=task-metadata", {
    waitUntil: "domcontentloaded",
  });
  const fixture = page.locator('[data-playground-section="task-metadata"]');
  await expect(fixture).toBeVisible();
  const counts: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    const measured = await measureAction(
      page,
      "reload task metadata",
      async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(fixture).toBeVisible();
      },
    );
    const component = measured.components["TaskMetadataPlayground"];
    if (component === undefined) {
      throw new Error("The app load did not render TaskMetadataPlayground");
    }
    counts.push(component.renders);
    expect(measured.commits).toBeGreaterThan(0);
    expect(measured.renders).toBeGreaterThan(0);
  }
  expect(counts.at(0)).toBeGreaterThan(0);
  expect(new Set(counts).size).toBe(1);
});

test("an action waits for a finite request that began before measurement", async ({
  context,
  page,
}) => {
  test.skip(
    !EXPECTS_DEV_RUNTIME,
    "The probe measures the development renderer.",
  );
  await installRenderProbe(context);
  await page.goto("/dev?visual=task-metadata", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-playground-section="task-metadata"]'),
  ).toBeVisible();
  let responseFinished = false;
  await page.route("**/__render-probe-pending", async (route) => {
    // real-time: the request must outlive the 500 ms quiet window to detect a missed in-flight request.
    await sleep(1500);
    await route.fulfill({ status: 204 });
    responseFinished = true;
  });
  const requested = page.waitForRequest("**/__render-probe-pending");
  const response = page.evaluate(async () => {
    const result = await fetch("/__render-probe-pending", {
      signal: AbortSignal.timeout(5000),
    });
    return result.status;
  });
  await requested;
  await measureAction(page, "wait for existing request", async () => {
    expect(responseFinished).toBe(true);
  });
  expect(await response).toBe(204);
});

test("an action includes delayed React updates without network activity", async ({
  context,
  page,
}) => {
  test.skip(
    !EXPECTS_DEV_RUNTIME,
    "The probe measures the development renderer.",
  );
  await installRenderProbe(context);
  await page.goto("/dev?visual=task-metadata", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-playground-section="task-metadata"]'),
  ).toBeVisible();
  const directory = await mkdtemp(
    new URL("../render-census-delayed-", import.meta.url),
  );
  const fixture = page.locator("#render-census-delayed");
  try {
    await writeFile(
      path.join(directory, "component.tsx"),
      `import { useState } from "react";
export const RenderCensusDelayed = () => {
  const [status, setStatus] = useState("idle");
  return <div>
    <button onClick={() => { setTimeout(() => setStatus("short complete"), 100); }}>Short update</button>
    <button onClick={() => { setTimeout(() => setStatus("late complete"), 100); }}>Late update</button>
    <output>{status}</output>
  </div>;
};
`,
    );
    const mountPath = path.join(directory, "mount.tsx");
    await writeFile(
      mountPath,
      `import { createRoot } from "react-dom/client";
import { RenderCensusDelayed } from "./component";
const host = document.createElement("div");
host.id = "render-census-delayed";
document.body.append(host);
createRoot(host).render(<RenderCensusDelayed />);
`,
    );
    await page.evaluate(async (moduleUrl) => {
      await import(moduleUrl);
    }, `/@fs${mountPath}`);
    await expect(fixture.getByText("idle", { exact: true })).toBeVisible();

    const short = await measureAction(
      page,
      "short delayed update",
      async () => {
        await fixture
          .getByRole("button", { name: "Short update", exact: true })
          .click();
      },
    );
    const shortComponent = short.components["RenderCensusDelayed"];
    if (shortComponent === undefined) {
      throw new Error("The short delayed render was not measured");
    }
    expect(shortComponent.renders).toBeGreaterThan(0);
    expect(short.wallMs).toBeGreaterThanOrEqual(100);
    await expect(
      fixture.getByText("short complete", { exact: true }),
    ).toBeVisible();

    const late = await measureAction(page, "late delayed update", async () => {
      // real-time: consume one quiet window before scheduling work that follows the action.
      await sleep(600);
      await fixture
        .getByRole("button", { name: "Late update", exact: true })
        .click();
    });
    const lateComponent = late.components["RenderCensusDelayed"];
    if (lateComponent === undefined) {
      throw new Error(
        "The delayed render after the long action was not measured",
      );
    }
    expect(lateComponent.renders).toBeGreaterThan(0);
    expect(late.wallMs).toBeGreaterThanOrEqual(700);
    await expect(
      fixture.getByText("late complete", { exact: true }),
    ).toBeVisible();
    const idle = await measureAction(
      page,
      "idle fixture",
      async () => undefined,
    );
    expect(idle.commits).toBe(0);
    expect(idle.wallMs).toBe(0);
  } finally {
    await page.close().finally(async () => {
      await rm(directory, { recursive: true, force: true });
    });
  }
});

test("React Refresh keeps rendering through the probe after a source update", async ({
  context,
  page,
}) => {
  test.skip(
    !EXPECTS_DEV_RUNTIME || process.env["STELLA_RENDER_CENSUS_HMR"] !== "1",
    "Source updates run only in the dedicated development census workflow.",
  );
  await installRenderProbe(context);
  await page.goto("/dev?visual=task-metadata", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-playground-section="task-metadata"]'),
  ).toBeVisible();
  const directory = await mkdtemp(
    new URL("../render-census-hmr-", import.meta.url),
  );
  const componentPath = path.join(directory, "component.tsx");
  const mountPath = path.join(directory, "mount.tsx");
  const original =
    "export const RenderCensusHmr = () => <p>Before refresh</p>;";
  const updated = "export const RenderCensusHmr = () => <p>After refresh</p>;";
  const fixture = page.locator("#render-census-hmr");
  const originalUrl = page.url();
  let navigations = 0;
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      navigations += 1;
    }
  };
  page.on("framenavigated", onNavigation);
  try {
    await writeFile(componentPath, original);
    await writeFile(
      mountPath,
      `import { createRoot } from "react-dom/client";
import { RenderCensusHmr } from "./component";
const host = document.createElement("div");
host.id = "render-census-hmr";
document.body.append(host);
createRoot(host).render(<RenderCensusHmr />);
`,
    );
    await page.evaluate(async (moduleUrl) => {
      await import(moduleUrl);
    }, `/@fs${mountPath}`);
    await expect(
      fixture.getByText("Before refresh", { exact: true }),
    ).toBeVisible();
    const measured = await measureAction(
      page,
      "refresh temporary component",
      async () => {
        await writeFile(componentPath, updated);
        await expect(
          fixture.getByText("After refresh", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
      },
    );
    const component = measured.components["RenderCensusHmr"];
    if (component === undefined) {
      throw new Error("React Refresh did not render RenderCensusHmr");
    }
    expect(component.renders).toBeGreaterThan(0);
    expect(measured.commits).toBeGreaterThan(0);
    expect(page.url()).toBe(originalUrl);
    expect(navigations).toBe(0);
  } finally {
    page.off("framenavigated", onNavigation);
    await page.close().finally(async () => {
      await rm(directory, { recursive: true, force: true });
    });
  }
});
