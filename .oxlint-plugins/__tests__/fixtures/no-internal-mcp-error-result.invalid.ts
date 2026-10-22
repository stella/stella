declare const errorResult: (message: string) => unknown;
declare const error: { message: string };
declare const result: {
  error: { cause: { message: string }; message: string };
};
declare const err: { details: { message: string } };
declare const driverError: { message: string };
errorResult(error.message);
errorResult(result.error.message);
errorResult(result.error.cause.message);
errorResult(err.details.message);
errorResult(driverError.message);
