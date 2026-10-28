declare const useMutation: (options: unknown) => unknown;
declare const analytics: { captureError: (error: unknown) => void };

export const useMissingFeedback = () =>
  useMutation({
    mutationFn: () => undefined,
    // oxlint-disable-next-line require-mutation-user-feedback/require-mutation-user-feedback
    onError: (error: unknown) => {
      analytics.captureError(error);
    },
  });
