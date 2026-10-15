import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";

import { unregisterDomEnvironment } from "@/test-dom-environment";
import { takeRefusedRequests } from "@/testing/dom-network-guard";

// Read before any DOM exists: these are the functions the guard must hand
// back when the DOM goes away.
const originalClient = {
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
};

GlobalRegistrator.register({ url: "http://localhost:3000/" });

afterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await unregisterDomEnvironment();
  }
});

const currentClient = () => ({
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
});

/** Settles once the request has finished, however it ended. */
const sendXhr = async (url: string) =>
  new Promise<number>((resolve) => {
    const request = new XMLHttpRequest();
    request.addEventListener("loadend", () => {
      resolve(request.status);
    });
    request.open("GET", url);
    request.send();
  });

describe("the DOM test network guard", () => {
  test.each([
    "http://localhost:3001/v1/guard-probe/fetch",
    "https://localhost:3001/v1/guard-probe/fetch",
  ])(
    "refuses an unmocked fetch to %s and records it even when the caller swallows the rejection",
    async (url) => {
      const outcome = await fetch(url).then(
        () => "answered",
        () => "rejected",
      );

      expect(outcome).toBe("rejected");
      expect(takeRefusedRequests()).toEqual([`${url} during this test`]);
    },
  );

  test("refuses an unmocked XMLHttpRequest and records it even though XHR reports failure only as an event", async () => {
    const url = "http://localhost:3001/v1/guard-probe/xhr";

    const status = await sendXhr(url);

    expect(status).toBe(0);
    expect(takeRefusedRequests()).toEqual([`${url} during this test`]);
  });

  test("unregistering the DOM hands back the original HTTP client functions", async () => {
    // The fixture must reach the boundary: while the DOM is up, none of the
    // client functions is the original.
    const guarded = currentClient();
    expect(guarded.httpRequest).not.toBe(originalClient.httpRequest);
    expect(guarded.httpGet).not.toBe(originalClient.httpGet);
    expect(guarded.httpsRequest).not.toBe(originalClient.httpsRequest);
    expect(guarded.httpsGet).not.toBe(originalClient.httpsGet);

    await unregisterDomEnvironment();

    const restored = currentClient();
    expect(restored.httpRequest).toBe(originalClient.httpRequest);
    expect(restored.httpGet).toBe(originalClient.httpGet);
    expect(restored.httpsRequest).toBe(originalClient.httpsRequest);
    expect(restored.httpsGet).toBe(originalClient.httpsGet);
  });
});
