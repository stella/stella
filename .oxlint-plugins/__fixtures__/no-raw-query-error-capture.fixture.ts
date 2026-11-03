const analytics = { captureError: (_error: unknown) => undefined };

export const rejectedQuery = {
  queryKey: ["rejected"],
  queryFn: async () => {
    await Promise.resolve();
    // oxlint-disable-next-line no-raw-query-error-capture/no-raw-query-error-capture -- detector fixture
    analytics.captureError(new Error("failure"));
  },
};

// expect-clean: no-raw-query-error-capture/no-raw-query-error-capture
export const acceptedHandler = () =>
  analytics.captureError(new Error("failure"));
