declare const errorResult: (message: string) => unknown;
declare const internalFailureResult: (error: unknown) => unknown;
declare const error: { message: string };
declare const usageRejection: { message: string };
declare const validation: { message: string };
errorResult("Forbidden");
errorResult(usageRejection.message);
errorResult(validation.message);
internalFailureResult(error);
