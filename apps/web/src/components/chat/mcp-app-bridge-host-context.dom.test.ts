import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AppBridge } from "@mcp-ui/client";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });

afterAll(async () => {
  await unregisterDomEnvironment();
});

const HOST_INFO = { name: "host", version: "1.0.0" };

const recordingTransport = () => {
  const sent: unknown[] = [];
  let delivery = Promise.withResolvers<undefined>();
  return {
    sent,
    nextSend: async () => await delivery.promise,
    transport: {
      onmessage: undefined as ((message: unknown) => void) | undefined,
      start: async () => {},
      close: async () => {},
      send: async (message: unknown) => {
        sent.push(message);
        delivery.resolve(undefined);
        delivery = Promise.withResolvers<undefined>();
      },
    },
  };
};

test("a host context set before the bridge connects is sent at initialization", async () => {
  const bridge = new AppBridge(null, HOST_INFO, {});
  const notified: Promise<void>[] = [];
  const notification = bridge.notification.bind(bridge);
  bridge.notification = async (...args) => {
    const sent = notification(...args);
    notified.push(sent);
    await sent;
  };

  bridge.setHostContext({ theme: "dark", locale: "cs" });
  expect(await Promise.allSettled(notified)).toEqual([]);

  const { sent, nextSend, transport } = recordingTransport();
  await bridge.connect(transport);
  const replied = nextSend();
  transport.onmessage?.({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {
      appInfo: { name: "app", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    },
  });
  await replied;

  expect(sent).toMatchObject([
    { id: 1, result: { hostContext: { theme: "dark", locale: "cs" } } },
  ]);
  await bridge.close();
});

test("a connected bridge sends only the changed host context fields", async () => {
  const bridge = new AppBridge(null, HOST_INFO, {});
  bridge.setHostContext({ theme: "dark", locale: "cs" });
  const { sent, nextSend, transport } = recordingTransport();
  await bridge.connect(transport);

  const notified = nextSend();
  bridge.setHostContext({ theme: "light", locale: "cs" });
  await notified;

  expect(sent).toEqual([
    {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    },
  ]);
  await bridge.close();
});
