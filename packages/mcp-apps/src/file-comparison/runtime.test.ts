import { App } from "@modelcontextprotocol/ext-apps";
import { expect, test } from "bun:test";

import { createFileComparisonRuntime } from "./runtime";

class ComparisonHost extends App {
  response =
    Promise.withResolvers<Awaited<ReturnType<App["callServerTool"]>>>();
  calls = 0;

  override async callServerTool() {
    this.calls += 1;
    return await this.response.promise;
  }
}

test("comparison rejects selection changes and duplicate uploads until the pending upload settles", async () => {
  const app = new ComparisonHost({ name: "comparison-host", version: "1.0.0" });
  const runtime = createFileComparisonRuntime(app);
  const base = new File(["original"], "original.docx");
  const target = new File(["revised"], "revised.docx");
  runtime.selectBase(base);
  runtime.selectTarget(target);
  const uploading = runtime.upload();
  expect(runtime.getSnapshot().uploadPhase).toBe("active");
  runtime.selectBase(new File(["replacement"], "replacement.docx"));
  runtime.selectTarget(new File(["replacement"], "replacement.docx"));
  await runtime.upload();
  expect(runtime.getSnapshot().base).toBe(base);
  expect(runtime.getSnapshot().target).toBe(target);
  expect(runtime.getSnapshot().uploadPhase).toBe("active");
  app.response.resolve({
    isError: true,
    content: [{ type: "text", text: "reservation failed" }],
  });
  await uploading;
  expect(app.calls).toBe(1);
  expect(runtime.getSnapshot().uploadPhase).toBe("idle");
  expect(runtime.getSnapshot().message).toBe("reservation failed");
  await runtime.upload();
  expect(app.calls).toBe(2);
  expect(runtime.getSnapshot().base).toBe(base);
  expect(runtime.getSnapshot().target).toBe(target);
  app.onerror?.(new Error("host disconnected"));
  expect(runtime.getSnapshot().message).toContain("host disconnected");
  expect(runtime.getSnapshot().status).toBe("error");
});
