import { App, EventDispatcher } from "@modelcontextprotocol/ext-apps";
import type { AppEventMap } from "@modelcontextprotocol/ext-apps";
import { act, render, screen } from "@testing-library/react";
import { expect, spyOn, test } from "bun:test";

import { DOCUMENT_VERSION_UPLOAD_TRANSPORT } from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

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
  expect(screen.getByRole("status").textContent).toContain(
    "reservation failed",
  );
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

class UploadFlowHost extends App {
  events = new EventDispatcher<AppEventMap>();
  timeline: string[] = [];
  toolCalls: Parameters<App["callServerTool"]>[0][] = [];
  finalizeOutcome: "success" | "failure" = "success";

  override addEventListener<K extends keyof AppEventMap>(
    event: K,
    listener: (value: AppEventMap[K]) => void,
  ) {
    this.events.addEventListener(event, listener);
  }

  override async callServerTool(input: Parameters<App["callServerTool"]>[0]) {
    this.toolCalls.push(input);
    const capability = input.arguments?.["capability"];
    this.timeline.push(String(capability));
    switch (capability) {
      case DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve:
        return {
          content: [],
          structuredContent: {
            result: {
              uploadId: "reserved-upload",
              url: "https://storage.example/upload",
              headers: { "content-type": "application/octet-stream" },
            },
          },
        };
      case DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize:
        return this.finalizeOutcome === "failure"
          ? {
              isError: true,
              content: [{ type: "text" as const, text: "finalize rejected" }],
            }
          : { content: [] };
      default:
        return { content: [] };
    }
  }
}

const selectUploadTarget = (
  app: UploadFlowHost,
  target: "original" | "replacement",
) => {
  app.events.dispatch("toolinput", {
    arguments: { entity_id: `document-${target}` },
  });
  app.events.dispatch("toolresult", {
    content: [],
    structuredContent: {
      entityId: `document-${target}`,
      workspaceId: `matter-${target}`,
    },
  });
};

test.each(["success", "put-failure", "finalize-failure"] as const)(
  "document upload %s finalizes or aborts the captured reservation and matter",
  async (outcome) => {
    const app = new UploadFlowHost({
      name: "upload-flow-host",
      version: "1.0.0",
    });
    app.finalizeOutcome =
      outcome === "finalize-failure" ? "failure" : "success";
    const runtime = createDocumentUploadRuntime(app);
    selectUploadTarget(app, "original");
    const file = new File(["payload"], "original.docx", {
      type: "application/octet-stream",
    });
    runtime.selectFile(file);
    const put = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          app.timeline.push("PUT");
          selectUploadTarget(app, "replacement");
          return new Response(null, {
            status: outcome === "put-failure" ? 503 : 200,
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      await runtime.upload();
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith(
        "https://storage.example/upload",
        expect.objectContaining({
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        }),
      );
      expect(app.toolCalls.at(0)).toEqual({
        name: MCP_CAPABILITY_EXECUTORS.write,
        arguments: {
          capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
          input: {
            body: {
              purpose: DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose,
              entityId: "document-original",
              name: file.name,
              size: file.size,
              mimeType: file.type,
              sha256Hex: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            params: { matterId: "matter-original" },
          },
        },
      });
      const finalize = {
        name: MCP_CAPABILITY_EXECUTORS.write,
        arguments: {
          capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
          input: {
            params: {
              uploadId: "reserved-upload",
              matterId: "matter-original",
            },
          },
        },
      };
      const abort = {
        name: MCP_CAPABILITY_EXECUTORS.write,
        arguments: {
          capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
          input: {
            params: {
              uploadId: "reserved-upload",
              matterId: "matter-original",
            },
          },
          confirm: true,
        },
      };
      expect(app.timeline).toEqual([
        DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
        "PUT",
        ...(outcome === "put-failure"
          ? []
          : [DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize]),
        ...(outcome === "success"
          ? []
          : [DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort]),
      ]);
      expect(app.toolCalls.slice(1)).toEqual(
        {
          success: [finalize],
          "put-failure": [abort],
          "finalize-failure": [finalize, abort],
        }[outcome],
      );
      expect(runtime.getSnapshot().uploadPhase).toBe("idle");
      expect(runtime.getSnapshot().file).toBe(
        outcome === "success" ? null : file,
      );
      expect(runtime.getSnapshot().status).toBe(
        outcome === "success" ? "success" : "error",
      );
      if (outcome === "finalize-failure") {
        expect(runtime.getSnapshot().message).toContain("finalize rejected");
      }
    } finally {
      put.mockRestore();
    }
  },
);
