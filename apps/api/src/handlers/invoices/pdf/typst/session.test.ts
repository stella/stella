import { afterAll, describe, expect, test } from "bun:test";

import { openTypstSession, TYPST_RENDER_LIMITS } from "./session";
import type { TypstRenderLimits, TypstRenderRequest } from "./session";

const MIB = 1024 * 1024;

const request = (template: string): TypstRenderRequest => ({
  template,
  inputs: {},
  format: "pdf",
});

const sessions: { close: () => Promise<void> }[] = [];
const session = (limits: Partial<TypstRenderLimits> = {}) => {
  const opened = openTypstSession({ ...TYPST_RENDER_LIMITS, ...limits });
  sessions.push(opened);
  return opened;
};

afterAll(async () => {
  await Promise.all(sessions.map((opened) => opened.close()));
});

const pdfHeader = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.subarray(0, 5));

describe("sandboxed Typst rendering of an untrusted template", () => {
  const shared = session();

  test("renders a benign template to a PDF", async () => {
    const outcome = await shared.render(request("Hello"));
    expect(outcome.status).toBe("rendered");
    if (outcome.status === "rendered") {
      expect(pdfHeader(outcome.bytes)).toBe("%PDF-");
    }
  });

  test.each([
    ['#read("/etc/passwd")'],
    ['#read("../../../../../../etc/passwd")'],
    ['#read("/apps/api/.env")'],
    ['#image("/etc/hosts")'],
    ['#json("/package.json")'],
    ['#plugin("/plugin.wasm")'],
    ['#import "@preview/cetz:0.3.4": canvas'],
    ['#include "/other.typ"'],
  ])("refuses file and package access: %s", async (template) => {
    const outcome = await shared.render(request(template));
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "diagnostics",
    });
    if (outcome.status === "rejected") {
      expect(outcome.diagnostics.join("\n")).toMatch(
        /access denied|failed to load|not found|cannot|package/iu,
      );
    }
  });

  test("Typst itself rejects unbounded recursion and obvious infinite loops", async () => {
    for (const template of ["#let f(x) = f(x + 1)\n#f(0)", "#while true {}"]) {
      const outcome = await shared.render(request(template));
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: "diagnostics",
      });
    }
  });

  test("terminates a render that runs past the time limit and stops spending CPU", async () => {
    const bounded = session({ timeoutMs: 400 });
    const started = performance.now();
    const outcome = await bounded.render(
      request(
        "#let n = 0\n#for i in range(20000) { for j in range(20000) { n += 1 } }\n#n",
      ),
    );
    const elapsed = performance.now() - started;
    expect(outcome).toMatchObject({ status: "rejected", reason: "timeout" });
    // Worker start (WASM instantiation, fonts) is outside the render clock.
    expect(elapsed).toBeLessThan(400 + 5000);
    const cpuBefore = process.cpuUsage();
    await Bun.sleep(300);
    const cpu = process.cpuUsage(cpuBefore);
    // A worker still looping would burn ~300 ms of CPU in this window.
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(150);
  });

  test("terminates a render that grows memory past the limit", async () => {
    const bounded = session({
      maxMemoryGrowthBytes: 128 * MIB,
      timeoutMs: 20_000,
    });
    const outcome = await bounded.render(
      request(
        "#let a = ()\n#for i in range(40000000) { a.push(str(i)) }\n#a.len()",
      ),
    );
    expect(outcome).toMatchObject({ status: "rejected" });
    if (outcome.status === "rejected") {
      expect(["memory", "crashed"]).toContain(outcome.reason);
    }
  });

  test("refuses output larger than the limit", async () => {
    const bounded = session({ maxOutputBytes: 256 * 1024 });
    const outcome = await bounded.render(
      request("#for i in range(200) [#lorem(400) #pagebreak()]"),
    );
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "output-too-large",
    });
  });

  test("refuses oversized templates and inputs before starting work", async () => {
    const bounded = session({ maxTemplateBytes: 64, maxInputBytes: 64 });
    expect(await bounded.render(request("x".repeat(65)))).toMatchObject({
      status: "rejected",
      reason: "template-too-large",
    });
    expect(
      await bounded.render({
        template: "#sys.inputs.data",
        inputs: { data: "y".repeat(65) },
        format: "pdf",
      }),
    ).toMatchObject({ status: "rejected", reason: "input-too-large" });
  });

  test("a session keeps rendering after a terminated worker", async () => {
    const bounded = session({ timeoutMs: 300 });
    const killed = await bounded.render(
      request(
        "#let n = 0\n#for i in range(20000) { for j in range(20000) { n += 1 } }",
      ),
    );
    expect(killed).toMatchObject({ status: "rejected", reason: "timeout" });
    const next = await bounded.render(request("After"));
    expect(next.status).toBe("rendered");
  });
});
