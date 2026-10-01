import { Panic, UnhandledException } from "better-result";
import { expect, test } from "bun:test";

import { DocxArchiveError } from "@stll/docx-utils";

import { resolveHandlerError } from "./handler-error-resolution";
import { HandlerError } from "./tagged-errors";

test("archive errors keep their client status through handler wrappers", () => {
  const archive = new DocxArchiveError({
    reason: "entry-too-large",
    message: "Invalid archive",
  });
  const wrapped = new HandlerError({
    status: 500,
    message: "Internal server error",
    cause: archive,
  });
  for (const error of [
    archive,
    wrapped,
    new Panic({ message: "request", cause: wrapped }),
    new UnhandledException({ cause: wrapped }),
  ]) {
    expect(resolveHandlerError(error)).toMatchObject({
      status: 422,
      message: "Invalid archive",
    });
  }
  const generic = new HandlerError({
    status: 500,
    message: "Internal server error",
  });
  expect(resolveHandlerError(generic)).toBe(generic);
  const explicit = new HandlerError({
    status: 503,
    message: "Retry later",
    cause: archive,
  });
  expect(resolveHandlerError(explicit)).toBe(explicit);
});
