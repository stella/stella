import { App } from "@modelcontextprotocol/ext-apps";
import { TaggedError } from "better-result";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";

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

afterEach(() => {
  mock.restore();
});

class HandoffHostError extends TaggedError("HandoffHostError")<{
  message: string;
}> {}

type HostMode = "message" | "context" | "unsupported";
type HostFailure = "none" | "reject" | "denied";
class HandoffHost extends App {
  mode: HostMode = "message";
  failure: HostFailure = "none";
  messages: Parameters<App["sendMessage"]>[0][] = [];
  contexts: Parameters<App["updateModelContext"]>[0][] = [];
  requests: Parameters<App["callServerTool"]>[0][] = [];
  reservation = {
    base: {
      url: "https://uploads.example.test/base",
      headers: { "x-upload": "base" },
    },
    target: {
      url: "https://uploads.example.test/target",
      headers: { "x-upload": "target" },
    },
    next: {
      source: {
        type: "uploads",
        base_upload_id: "reserved-base-id",
        target_upload_id: "reserved-target-id",
      },
      output: "docx",
    },
  };

  override getHostCapabilities() {
    switch (this.mode) {
      case "message":
        return {
          message: { text: {} },
          updateModelContext: { text: {}, structuredContent: {} },
        };
      case "context":
        return { updateModelContext: { text: {}, structuredContent: {} } };
      case "unsupported":
        return {};
      default:
        return this.mode satisfies never;
    }
  }

  override async callServerTool(request: Parameters<App["callServerTool"]>[0]) {
    this.requests.push(request);
    return { content: [], structuredContent: this.reservation };
  }

  override async sendMessage(message: Parameters<App["sendMessage"]>[0]) {
    this.messages.push(message);
    if (this.failure === "reject") {
      throw new HandoffHostError({ message: "host handoff failed" });
    }
    return { isError: this.failure === "denied" };
  }

  override async updateModelContext(
    context: Parameters<App["updateModelContext"]>[0],
  ) {
    this.contexts.push(context);
    if (this.failure === "reject") {
      throw new HandoffHostError({ message: "host handoff failed" });
    }
    return {};
  }
}

test.each(["message", "context"] satisfies HostMode[])(
  "successful dual PUT preserves reservation IDs in the %s handoff",
  async (mode) => {
    const host = new HandoffHost({ name: "handoff-host", version: "1.0.0" });
    host.mode = mode;
    const base = new File(["original"], "original.docx");
    const target = new File(["revised"], "revised.docx");
    const uploaded: {
      url: string;
      body: unknown;
      method: string | undefined;
      headers: HeadersInit | undefined;
    }[] = [];
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (...[input, init]: Parameters<typeof fetch>) => {
          uploaded.push({
            url: String(input),
            body: init?.body,
            method: init?.method,
            headers: init?.headers,
          });
          return new Response(null, { status: 200 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const runtime = createFileComparisonRuntime(host);
    runtime.selectBase(base);
    runtime.selectTarget(target);
    await runtime.upload();
    expect(uploaded).toEqual([
      {
        url: host.reservation.base.url,
        body: base,
        method: "PUT",
        headers: host.reservation.base.headers,
      },
      {
        url: host.reservation.target.url,
        body: target,
        method: "PUT",
        headers: host.reservation.target.headers,
      },
    ]);
    expect(host.requests).toHaveLength(1);
    expect(host.requests.at(0)?.name).toBe(
      FILE_COMPARISON_TRANSPORT.prepareToolName,
    );
    const content = [
      {
        type: "text" as const,
        text: `Both files are uploaded. Call ${FILE_COMPARISON_TRANSPORT.compareToolName} with source ${JSON.stringify(host.reservation.next.source)}.`,
      },
    ];
    if (mode === "message") {
      expect(host.messages).toEqual([{ role: "user", content }]);
      expect(host.contexts).toEqual([]);
    } else {
      expect(host.messages).toEqual([]);
      expect(host.contexts).toEqual([
        { content, structuredContent: host.reservation.next },
      ]);
    }
    expect(runtime.getSnapshot().status).toBe("success");
    expect(runtime.getSnapshot().base).toBeNull();
    expect(runtime.getSnapshot().target).toBeNull();
  },
);

const fallbackHosts = [
  { mode: "unsupported", failure: "none", status: "success" },
  { mode: "message", failure: "reject", status: "error" },
  { mode: "message", failure: "denied", status: "error" },
  { mode: "context", failure: "reject", status: "error" },
] satisfies {
  mode: HostMode;
  failure: HostFailure;
  status: "success" | "error";
}[];

test.each(fallbackHosts)(
  "uploaded source IDs remain actionable when handoff cannot complete: %j",
  async ({ mode, failure, status }) => {
    const host = new HandoffHost({ name: "handoff-host", version: "1.0.0" });
    host.mode = mode;
    host.failure = failure;
    const uploads = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const runtime = createFileComparisonRuntime(host);
    runtime.selectBase(new File(["original"], "original.docx"));
    runtime.selectTarget(new File(["revised"], "revised.docx"));
    await runtime.upload();
    expect(uploads).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().status).toBe(status);
    expect(runtime.getSnapshot().message).toContain(
      JSON.stringify(host.reservation.next.source),
    );
    if (failure === "reject") {
      expect(runtime.getSnapshot().message).toContain("host handoff failed");
    }
    expect(runtime.getSnapshot().base).toBeNull();
    expect(runtime.getSnapshot().target).toBeNull();
  },
);
