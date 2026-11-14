declare const errorResult: (message: string) => object;
declare const internalFailureResult: (error: unknown) => object;
declare const result: { error: { message: string } };
declare const error: Error;
declare const usageRejection: { message: string };

// oxlint-disable-next-line no-raw-mcp-error-result/no-raw-mcp-error-result -- fixture proves Result errors cannot be flattened into plain-text tool failures
const rejectedResultError = errorResult(result.error.message);

// oxlint-disable-next-line no-raw-mcp-error-result/no-raw-mcp-error-result -- fixture proves direct caught errors cannot be flattened into plain-text tool failures
const rejectedCaughtError = errorResult(error.message);

// expect-clean: no-raw-mcp-error-result/no-raw-mcp-error-result
const acceptedEnvelope = internalFailureResult(result.error);

// expect-clean: no-raw-mcp-error-result/no-raw-mcp-error-result
const acceptedDomainMessage = errorResult(usageRejection.message);

export const fixtureValues = [
  rejectedResultError,
  rejectedCaughtError,
  acceptedEnvelope,
  acceptedDomainMessage,
];
