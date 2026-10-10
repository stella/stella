import { Result } from "better-result";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { parsePlainDate } from "@stll/time";

import { SoftLawItemError } from "./soft-law-types";
import type { SoftLawDocumentInput, SoftLawMetadata } from "./soft-law-types";

const normalizeTitle = (value: string) =>
  value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
const normalizeReference = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
const compareCanonicalKeys = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** The locator never supplies identity; numbered references normalize compatibility characters. */
export const softLawIdentityKey = (
  authority: string,
  metadata: SoftLawMetadata,
): Result<string, SoftLawItemError> => {
  if (!metadata.title.trim()) {
    return Result.err(
      new SoftLawItemError({
        message: "Document title is empty",
        tag: "invalid_document",
      }),
    );
  }
  if (
    metadata.issuedOn.state === "stated" &&
    parsePlainDate(metadata.issuedOn.value) === null
  ) {
    return Result.err(
      new SoftLawItemError({
        message: "Issue date is not a valid ISO date",
        tag: "invalid_document",
      }),
    );
  }
  if (metadata.statedReference.state === "stated") {
    if (!metadata.statedReference.value.trim()) {
      return Result.err(
        new SoftLawItemError({
          message: "Document reference is empty",
          tag: "invalid_document",
        }),
      );
    }
    return Result.ok(
      JSON.stringify([
        authority,
        "reference",
        normalizeReference(metadata.statedReference.value),
      ]),
    );
  }
  return Result.ok(
    JSON.stringify([
      authority,
      "title",
      normalizeTitle(metadata.title),
      metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
    ]),
  );
};

/** Explicit field order keeps equivalent metadata independent of object insertion order. */
export const softLawContentHash = (input: SoftLawDocumentInput) => {
  const { metadata } = input;
  const canonical = {
    title: metadata.title,
    kind: metadata.kind,
    reference:
      metadata.statedReference.state === "stated"
        ? metadata.statedReference.value
        : null,
    issuedOn:
      metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
    validityState: metadata.validity.state,
    validityBasis: metadata.validity.basis,
  };
  const raw = input.raw
    .map((part) => ({
      role: part.role,
      digest: hashSha256Hex(part.bytes),
    }))
    .toSorted((a, b) => compareCanonicalKeys(a.role, b.role));
  const sourceDates = Object.entries(input.sourceDates).toSorted(
    ([left], [right]) => compareCanonicalKeys(left, right),
  );
  return hashSha256Hex(
    JSON.stringify({
      metadata: canonical,
      raw,
      sourceDates,
    }),
  );
};
