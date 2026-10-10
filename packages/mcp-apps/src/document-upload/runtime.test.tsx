import { App, EventDispatcher } from "@modelcontextprotocol/ext-apps";
import type { AppEventMap } from "@modelcontextprotocol/ext-apps";
import { act, render, screen } from "@testing-library/react";
import { expect, test } from "bun:test";

import { createDocumentUploadRuntime } from "./runtime";
import { DocumentUpload } from "./view";

class UploadHost extends App {
  events = new EventDispatcher<AppEventMap>();
  response =
    Promise.withResolvers<Awaited<ReturnType<App["callServerTool"]>>>();
  calls = 0;

  override addEventListener<K extends keyof AppEventMap>(
    event: K,
    listener: (value: AppEventMap[K]) => void,
  ) {
    this.events.addEventListener(event, listener);
  }

  override async callServerTool() {
    this.calls += 1;
    return await this.response.promise;
  }
}

test("document upload stays disabled through host updates and preserves the file for retry", async () => {
  const app = new UploadHost({ name: "upload-host", version: "1.0.0" });
  const runtime = createDocumentUploadRuntime(app);
  app.events.dispatch("hostcontextchanged", { locale: "cs" });
  app.events.dispatch("toolinput", { arguments: { entity_id: "document-a" } });
  app.events.dispatch("toolresult", {
    content: [],
    structuredContent: { entityId: "document-a", workspaceId: "matter" },
  });
  const file = new File(["original"], "original.docx");
  runtime.selectFile(file);
  render(<DocumentUpload runtime={runtime} />);
  let uploading: Promise<void> | undefined;
  act(() => {
    uploading = runtime.upload();
  });
  expect(runtime.getSnapshot().uploadPhase).toBe("active");
  act(() => {
    runtime.selectFile(new File(["replacement"], "replacement.docx"));
    app.events.dispatch("toolinput", {
      arguments: { entity_id: "document-b" },
    });
    app.events.dispatch("toolresult", {
      content: [],
      structuredContent: { entityId: "document-b", workspaceId: "matter" },
    });
  });
  expect(runtime.getSnapshot().file).toBe(file);
  expect(
    screen
      .getByRole("button", { name: "Nahrát verzi" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await runtime.upload();
  app.response.resolve({
    isError: true,
    content: [{ type: "text", text: "reservation failed" }],
  });
  await act(async () => {
    await uploading;
  });
  expect(app.calls).toBe(1);
  expect(runtime.getSnapshot().uploadPhase).toBe("idle");
  expect(runtime.getSnapshot().file).toBe(file);
  expect(
    screen
      .getByRole("button", { name: "Nahrát verzi" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("reservation failed");
  await act(async () => {
    await runtime.upload();
  });
  expect(app.calls).toBe(2);
  act(() => {
    app.onerror?.(new Error("host disconnected"));
  });
  expect(screen.getByRole("status").textContent).toBe(
    "Nahrání se nezdařilo: host disconnected",
  );
});
