import { describe, expect, test } from "bun:test";

import {
  InfoSoudAPIError,
  InfoSoudPragueCourtResolutionError,
  InfoSoudRequestError,
} from "./errors.js";
import type { SpisZn } from "./types.js";

describe("InfoSoudAPIError", () => {
  test("preserves ErrorOptions cause like the other exported error types", () => {
    const cause = new Error("upstream failed");
    const error = new InfoSoudAPIError({
      cause,
      message: "Bad request",
      path: "/rizeni/vyhledej",
      responseBody: { message: "invalid" },
      status: 400,
    });

    expect(error.cause).toBe(cause);
    expect(error.status).toBe(400);
    expect(error.path).toBe("/rizeni/vyhledej");
  });
});

describe("InfoSoudPragueCourtResolutionError", () => {
  const spisZn: SpisZn = {
    bcVec: 64,
    cisloSenatu: 1,
    druhVeci: "T",
    rocnik: 2024,
  };

  test("is discriminable by class without sniffing the message", () => {
    const error = new InfoSoudPragueCourtResolutionError(
      "/rizeni/vyhledej",
      spisZn,
    );

    // Discriminates against its own class...
    expect(error).toBeInstanceOf(InfoSoudPragueCourtResolutionError);
    // ...and still satisfies the generic request-error fallback.
    expect(error).toBeInstanceOf(InfoSoudRequestError);
    expect(error.name).toBe("InfoSoudPragueCourtResolutionError");
    expect(error.path).toBe("/rizeni/vyhledej");
    expect(error.spisZn).toEqual(spisZn);
  });

  test("carries the queried case mark in a stable message", () => {
    const error = new InfoSoudPragueCourtResolutionError(
      "/jednani/vyhledej",
      spisZn,
    );

    expect(error.message).toBe(
      "Cannot resolve Prague district court for 1 T 64/2024",
    );
  });

  test("a plain InfoSoudRequestError is not misclassified as the Prague variant", () => {
    const error = new InfoSoudRequestError(
      "/rizeni/vyhledej",
      "Request failed for /rizeni/vyhledej",
    );

    expect(error).not.toBeInstanceOf(InfoSoudPragueCourtResolutionError);
  });
});
