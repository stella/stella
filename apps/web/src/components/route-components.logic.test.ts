import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

import {
  buildErrorReportMailto,
  isNetworkError,
  recoverRouteError,
  resolveRouteErrorRecovery,
  resolveRouteErrorSupport,
} from "./route-components.logic";

describe("route error recovery", () => {
  test("reloads for every browser dynamic-import failure shape", () => {
    const messages = [
      "Failed to fetch dynamically imported module: https://example.test/chunk.js",
      "error loading dynamically imported module: https://example.test/chunk.js",
      "Importing a module script failed.",
    ];

    for (const message of messages) {
      expect(resolveRouteErrorRecovery(new TypeError(message))).toEqual({
        type: "reload-page",
      });
    }
  });

  test("records the retry before reloading a cached rejected import", async () => {
    const actions: string[] = [];
    let finishRecording: () => void = () => undefined;

    const recovery = recoverRouteError({
      error: new TypeError(
        "Failed to fetch dynamically imported module: https://example.test/chunk.js",
      ),
      recordRetryStarted: async () =>
        new Promise<void>((resolve) => {
          actions.push("record");
          finishRecording = resolve;
        }),
      reloadPage: () => {
        actions.push("reload");
      },
      retryRoute: () => {
        actions.push("retry");
      },
    });

    expect(actions).toEqual(["record"]);
    finishRecording();
    await recovery;
    expect(actions).toEqual(["record", "reload"]);
  });

  test("keeps ordinary route errors on the in-app retry path", async () => {
    const actions: string[] = [];

    await recoverRouteError({
      error: new TypeError("Cannot read properties of null"),
      recordRetryStarted: async () => {
        actions.push("record");
      },
      reloadPage: () => {
        actions.push("reload");
      },
      retryRoute: () => {
        actions.push("retry");
      },
    });

    expect(actions).toEqual(["record", "retry"]);
  });
});

describe("route network error classification", () => {
  test("recognises query timeouts and browser network errors", () => {
    expect(
      isNetworkError(
        new CriticalQueryTimeoutError({
          message: "Critical query timed out",
          queryKey: ["files", "field_1"],
          timeoutMs: 10_000,
        }),
      ),
    ).toBe(true);
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isNetworkError(
        new TypeError("NetworkError when attempting to fetch resource."),
      ),
    ).toBe(true);
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);
  });

  test("treats status 0 API and auth errors as transient network failures", () => {
    expect(
      isNetworkError(
        new APIError({
          status: 0,
          message: "Storage fetch failed before response (purpose=display)",
        }),
      ),
    ).toBe(true);
    expect(
      isNetworkError(
        new AuthClientError({
          message: "Unknown error",
          status: 0,
          statusText: "",
        }),
      ),
    ).toBe(true);
  });

  test("does not classify ordinary API or type errors as network failures", () => {
    expect(
      isNetworkError(new APIError({ status: 500, message: "Server error" })),
    ).toBe(false);
    expect(
      isNetworkError(new TypeError("Cannot read properties of null")),
    ).toBe(false);
  });
});

describe("route error support", () => {
  test("uses a deployment-configured feedback recipient", () => {
    expect(
      resolveRouteErrorSupport({
        deployment: "selfHosted",
        feedbackRecipient: "ops@example.test",
      }),
    ).toEqual({ type: "report", recipient: "ops@example.test" });
  });

  test("directs self-hosted users to their administrator when email is unset", () => {
    expect(
      resolveRouteErrorSupport({
        deployment: "selfHosted",
        feedbackRecipient: undefined,
      }),
    ).toEqual({ type: "administrator" });
  });

  test("does not invent a support destination for unconfigured hosted deployments", () => {
    expect(
      resolveRouteErrorSupport({
        deployment: "hosted",
        feedbackRecipient: undefined,
      }),
    ).toEqual({ type: "none" });
  });

  test("builds a report containing only caller-provided support copy", () => {
    const href = buildErrorReportMailto({
      body: "Error reference: ERR-DEAD-BEEF-1234",
      recipient: "ops@example.test",
      subject: "stella error ERR-DEAD-BEEF-1234",
    });

    expect(decodeURIComponent(href)).toBe(
      "mailto:ops@example.test?subject=stella error ERR-DEAD-BEEF-1234&body=Error reference: ERR-DEAD-BEEF-1234",
    );
    expect(href).not.toContain("workspaces");
  });
});
