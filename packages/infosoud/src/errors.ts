import type { SpisZn } from "./types.js";

export class InfoSoudError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudError";
  }
}

export class InfoSoudAPIError extends InfoSoudError {
  readonly path: string;
  readonly responseBody: unknown;
  readonly status: number;

  constructor({
    cause,
    message,
    path,
    responseBody,
    status,
  }: {
    cause?: unknown;
    message: string;
    path: string;
    responseBody: unknown;
    status: number;
  }) {
    super(message, { cause });
    this.name = "InfoSoudAPIError";
    this.path = path;
    this.responseBody = responseBody;
    this.status = status;
  }
}

export class InfoSoudParseError extends InfoSoudError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudParseError";
  }
}

export class InfoSoudRequestError extends InfoSoudError {
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudRequestError";
    this.path = path;
  }
}

/**
 * Raised when a Prague spisová značka cannot be attributed to a single
 * obvodní soud because every candidate district rejected the lookup.
 *
 * A distinct class so callers can map this "case not found" outcome to
 * their own status codes without sniffing the error message; extends
 * {@link InfoSoudRequestError} so existing request-error handling still
 * applies as a fallback.
 */
export class InfoSoudPragueCourtResolutionError extends InfoSoudRequestError {
  readonly spisZn: SpisZn;

  constructor(path: string, spisZn: SpisZn, options?: ErrorOptions) {
    super(
      path,
      `Cannot resolve Prague district court for ${spisZn.cisloSenatu} ${spisZn.druhVeci} ${spisZn.bcVec}/${spisZn.rocnik}`,
      options,
    );
    this.name = "InfoSoudPragueCourtResolutionError";
    this.spisZn = spisZn;
  }
}
