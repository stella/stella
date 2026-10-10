import { Panic, UnhandledException } from "better-result";
import { expect, test } from "bun:test";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";
import { DocxArchiveError } from "@stll/docx-utils";

import { actionAdmissionErrorFor } from "@/api/tests/helpers/action-admission-error";

import {
  actionAdmissionRefusal,
  type ActionAdmissionError,
} from "./action-admission-error";
import {
  MAX_TRANSPORT_WRAPPER_DEPTH,
  resolveHandlerError,
} from "./handler-error-resolution";
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

const admissionReasons = {
  busy: true,
  period_exhausted: true,
  daily_exhausted: true,
  not_enabled: true,
  not_on_plan: true,
  unavailable: true,
} as const satisfies Record<ActionAdmissionError["reason"], true>;

test("all admission refusals preserve the canonical contract through bounded wrappers", () => {
  const codes = new Set<string>();
  for (const reason of Object.keys(admissionReasons)) {
    if (
      !(
        reason === "busy" ||
        reason === "period_exhausted" ||
        reason === "daily_exhausted" ||
        reason === "not_enabled" ||
        reason === "not_on_plan" ||
        reason === "unavailable"
      )
    ) {
      throw new Error("Unknown admission reason");
    }
    const refusal = actionAdmissionErrorFor(
      reason,
      "Private coordination detail",
    );
    codes.add(refusal.code);
    const expected = actionAdmissionRefusal(
      refusal,
      "https://example.test/contact",
    );
    const generic = new HandlerError({
      status: 500,
      message: "Request failed",
      cause: refusal,
    });
    for (const wrapped of [
      refusal,
      generic,
      new Error("Domain wrapper", { cause: refusal }),
      new Panic({ message: "request", cause: generic }),
      new UnhandledException({ cause: refusal }),
    ]) {
      const resolved = resolveHandlerError(
        wrapped,
        "https://example.test/contact",
      );
      expect(resolved).toMatchObject(expected);
      expect(resolved?.cause).toBe(refusal);
    }
    const explicit = new HandlerError({
      status: 409,
      message: "Conflict",
      cause: refusal,
    });
    expect(resolveHandlerError(explicit)).toBe(explicit);
    let bounded: unknown = refusal;
    for (let depth = 0; depth < MAX_TRANSPORT_WRAPPER_DEPTH; depth++) {
      bounded = new Error("Domain wrapper", { cause: bounded });
    }
    expect(resolveHandlerError(bounded)).toMatchObject(
      ACTION_ADMISSION_REFUSALS[refusal.code],
    );
    expect(
      resolveHandlerError(new Error("Too deep", { cause: bounded })),
    ).toBeNull();
  }
  expect([...codes].toSorted()).toEqual(
    Object.keys(ACTION_ADMISSION_REFUSALS).toSorted(),
  );
});

test("unavailable wrapper causes leave the generic boundary outcome intact", () => {
  const error = Object.defineProperty(new Error("Request failed"), "cause", {
    get: () => {
      throw new Error("Cause unavailable");
    },
  });
  expect(resolveHandlerError(error)).toBeNull();
});
