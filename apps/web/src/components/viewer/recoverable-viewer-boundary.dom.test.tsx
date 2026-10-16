import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import messages from "@/i18n/langs/en.json";
import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const sessionArea = () =>
  browserStorage("session") ?? panic("Test requires session browser storage");

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, Suspense } = await import("react");
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useSuspenseQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { APIError } = await import("@/lib/errors/api");
const { RecoverableViewerBoundary } =
  await import("@/components/viewer/recoverable-viewer-boundary");

// The stale-deployment guard reads this key; see preload-error-recovery.ts.
const RELOAD_GUARD_KEY = "stella:preload-reload-at";
const NO_BACKOFF = [0, 0] as const;
const RENDERED = "rendered file";

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  sessionArea().clear();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

type FileSource = { load: () => Promise<string> };

/** Fails with `error` for the first `failures` loads, then succeeds. */
const flakySource = (failures: number, error: () => Error): FileSource => {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      if (calls <= failures) {
        throw error();
      }
      return RENDERED;
    },
  };
};

const FileBody = ({ source }: { source: FileSource }) => {
  const { data } = useSuspenseQuery({
    queryKey: ["viewer-test-file"],
    queryFn: source.load,
    retry: false,
  });
  return <p>{data}</p>;
};

type MountOptions = {
  source: FileSource;
  finalFallback?: (error: Error) => ReactNode;
  onDownload?: () => void;
  onError?: (error: Error) => void;
};

const mount = ({
  source,
  finalFallback,
  onDownload,
  onError,
}: MountOptions) => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RecoverableViewerBoundary
          finalFallback={finalFallback}
          onDownload={onDownload}
          onError={onError}
          retryDelaysMs={NO_BACKOFF}
          surface="document-pdf"
        >
          <Suspense fallback={null}>
            <FileBody source={source} />
          </Suspense>
        </RecoverableViewerBoundary>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const transient = () => new APIError({ status: 503, message: "unavailable" });
const expiredUrl = () =>
  new APIError({
    status: 403,
    message: "expired",
    details: { phase: "response", purpose: "display" },
  });

describe("RecoverableViewerBoundary", () => {
  test("heals transient failures by refetching, without showing a failure", async () => {
    const errors: Error[] = [];
    mount({
      source: flakySource(2, expiredUrl),
      onError: (error) => {
        errors.push(error);
      },
    });

    expect(await screen.findByText(RENDERED)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(errors).toEqual([]);
  });

  test("after automatic attempts run out, offers try again and download", async () => {
    const downloads: string[] = [];
    const errors: Error[] = [];
    // One first failure plus both automatic attempts.
    mount({
      source: flakySource(NO_BACKOFF.length + 1, transient),
      onDownload: () => {
        downloads.push("original");
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(messages.fileDetail.displayFailed);
    expect(errors).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: messages.common.download }),
    );
    expect(downloads).toEqual(["original"]);

    fireEvent.click(
      screen.getByRole("button", { name: messages.common.tryAgain }),
    );
    expect(await screen.findByText(RENDERED)).toBeDefined();
  });

  test("a final failure shows the caller's answer at once, without retrying", async () => {
    const source = flakySource(
      1,
      () => new APIError({ status: 400, message: "no rendition" }),
    );
    mount({
      source,
      finalFallback: (error) =>
        APIError.is(error) && error.status === 400 ? (
          <p data-testid="side-panel" />
        ) : undefined,
    });

    expect(await screen.findByTestId("side-panel")).toBeDefined();
    expect(screen.queryByText(RENDERED)).toBeNull();
  });

  test("a final failure the caller does not recognise keeps the generic state", async () => {
    mount({
      source: flakySource(
        1,
        () => new APIError({ status: 404, message: "gone" }),
      ),
      finalFallback: () => undefined,
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      messages.fileDetail.displayFailed,
    );
  });

  test("a stale build that already reloaded once fails instead of looping", async () => {
    sessionArea().setItem(
      RELOAD_GUARD_KEY,
      String(Temporal.Now.instant().epochMilliseconds),
    );
    mount({
      source: flakySource(
        1,
        () =>
          new TypeError("Failed to fetch dynamically imported module: /x.js"),
      ),
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      messages.fileDetail.displayFailed,
    );
  });
});
