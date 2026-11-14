import { afterEach, describe, expect, test } from "bun:test";

import { subscribeComposeFieldChanges } from "@/outlook";

type FakeItemOptions = {
  mode: "compose" | "read";
  supportedVersions: readonly string[];
};

const installFakeOffice = ({ mode, supportedVersions }: FakeItemOptions) => {
  const handlers = new Map<string, () => void>();
  const item = {
    addHandlerAsync: (eventType: string, handler: () => void) => {
      handlers.set(eventType, handler);
    },
    removeHandlerAsync: (eventType: string) => {
      handlers.delete(eventType);
    },
    // A compose item's fields are read asynchronously; a read item's are plain.
    subject:
      mode === "compose" ? { getAsync: () => undefined } : "Re: agreement",
  };
  Reflect.set(globalThis, "Office", {
    context: {
      mailbox: { item },
      requirements: {
        isSetSupported: (name: string, version: string) =>
          name === "Mailbox" && supportedVersions.includes(version),
      },
    },
    EventType: {
      AttachmentsChanged: "olkAttachmentsChanged",
      RecipientsChanged: "olkRecipientsChanged",
    },
    onReady: async () => await Promise.resolve(),
  });
  return handlers;
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Office");
});

describe("subscribeComposeFieldChanges", () => {
  test("hears recipient and attachment edits while composing", () => {
    const handlers = installFakeOffice({
      mode: "compose",
      supportedVersions: ["1.7", "1.8"],
    });
    let calls = 0;
    const unsubscribe = subscribeComposeFieldChanges(() => {
      calls += 1;
    });

    expect([...handlers.keys()].toSorted()).toEqual([
      "olkAttachmentsChanged",
      "olkRecipientsChanged",
    ]);
    for (const handler of handlers.values()) {
      handler();
    }
    expect(calls).toBe(2);

    unsubscribe();
    expect(handlers.size).toBe(0);
  });

  test("listens only for the events the host supports", () => {
    const handlers = installFakeOffice({
      mode: "compose",
      supportedVersions: ["1.7"],
    });
    subscribeComposeFieldChanges(() => undefined);
    expect([...handlers.keys()]).toEqual(["olkRecipientsChanged"]);
  });

  test("does not listen on a read item", () => {
    const handlers = installFakeOffice({
      mode: "read",
      supportedVersions: ["1.7", "1.8"],
    });
    subscribeComposeFieldChanges(() => undefined);
    expect(handlers.size).toBe(0);
  });
});
