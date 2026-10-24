import { Result } from "better-result";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { normalizeUnicode } from "@stll/text-normalize";
import { parsePlainDate } from "@stll/time";

import {
  SOFT_LAW_AUTHORITY_POLICIES,
  validateSoftLawAuthorityMetadata,
} from "./soft-law-authority-policy";
import { SoftLawItemError } from "./soft-law-types";
import type {
  SoftLawAuthority,
  SoftLawDocumentInput,
  SoftLawMetadata,
  SoftLawStated,
} from "./soft-law-types";

const normalizeTitle = (value: string) =>
  normalizeUnicode(value, "NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
const normalizeReference = (value: string) =>
  normalizeUnicode(value, "NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
const normalizeRevisionKey = (value: string) => {
  if (!value.startsWith("rev")) {
    return value;
  }

  const digits = value.slice(value.startsWith("rev.") ? 4 : 3);
  if (!/^\d+$/u.test(digits)) {
    return value;
  }

  let firstSignificantDigit = 0;
  while (
    firstSignificantDigit < digits.length - 1 &&
    digits[firstSignificantDigit] === "0"
  ) {
    firstSignificantDigit += 1;
  }
  return `rev${digits.slice(firstSignificantDigit)}`;
};
const statedValue = <T>(value: SoftLawStated<T>) =>
  value.state === "stated" ? value.value : null;
const compareCanonicalKeys = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const softLawExpressionIdentityParts = (
  authority: SoftLawAuthority,
  metadata: SoftLawMetadata,
) => {
  const expression = metadata.expression;
  if (expression?.type !== "identified") {
    return null;
  }
  let revisionKey =
    expression.revision.state === "stated"
      ? normalizeReference(expression.revision.value)
      : null;
  if (
    SOFT_LAW_AUTHORITY_POLICIES[authority].referenceStyle === "wp_number" &&
    revisionKey !== null
  ) {
    revisionKey = normalizeRevisionKey(revisionKey.replace(/\s+/gu, ""));
  }
  return [
    metadata.kind,
    expression.language.toLowerCase(),
    revisionKey,
  ] as const;
};
/** The locator never supplies identity; numbered references normalize compatibility characters. */
export const softLawIdentityKey = (
  authority: SoftLawAuthority,
  metadata: SoftLawMetadata,
  extraction?: Pick<SoftLawDocumentInput, "extractionQuality" | "text">,
): Result<string, SoftLawItemError> => {
  const admitted = validateSoftLawAuthorityMetadata(
    authority,
    metadata,
    extraction,
  );
  if (admitted.status === "error") {
    return admitted;
  }
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
  const expression = metadata.expression;
  const wpNumber =
    SOFT_LAW_AUTHORITY_POLICIES[authority].referenceStyle === "wp_number";
  const expressionKey: (string | null)[] = [];
  if (expression?.type === "identified") {
    if (
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(expression.language) ||
      (expression.revision.state === "stated" &&
        !expression.revision.value.trim())
    ) {
      return Result.err(
        new SoftLawItemError({
          message: "Expression language or revision is invalid",
          tag: "invalid_document",
        }),
      );
    }
    const expressionIdentity = softLawExpressionIdentityParts(
      authority,
      metadata,
    );
    if (!expressionIdentity) {
      return Result.err(
        new SoftLawItemError({
          message: "Expression identity is missing",
          tag: "invalid_document",
        }),
      );
    }
    const [, language, revisionKey] = expressionIdentity;
    expressionKey.push("expression", metadata.kind, language, revisionKey);
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
    let reference = normalizeReference(metadata.statedReference.value);
    if (wpNumber) {
      if (!/^wp\s*\d+[a-z]?(?:\s*(?:rev\.?\s*\d+|update))?$/u.test(reference)) {
        return Result.err(
          new SoftLawItemError({
            message: "WP29 document reference is invalid",
            tag: "invalid_document",
          }),
        );
      }
      reference = reference.replace(/\s+/gu, "");
      const revisionStart = reference.lastIndexOf("rev");
      if (revisionStart !== -1) {
        reference = `${reference.slice(0, revisionStart)}${normalizeRevisionKey(
          reference.slice(revisionStart),
        )}`;
      }
    }
    const identitySeries =
      SOFT_LAW_AUTHORITY_POLICIES[authority].identitySeries;
    return Result.ok(
      JSON.stringify([
        authority,
        "reference",
        ...(identitySeries.type === "source-kind"
          ? [normalizeReference(metadata.sourceKind ?? metadata.kind)]
          : []),
        reference,
        ...expressionKey,
      ]),
    );
  }
  if (metadata.sourceDocumentId?.trim()) {
    return Result.ok(
      JSON.stringify([
        authority,
        "publisher-id",
        metadata.sourceDocumentId,
        ...expressionKey,
      ]),
    );
  }
  return Result.ok(
    JSON.stringify([
      authority,
      "title",
      normalizeTitle(metadata.title),
      metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
      ...expressionKey,
    ]),
  );
};

/** Explicit field order keeps equivalent metadata independent of object insertion order. */
export const softLawContentHash = (input: SoftLawDocumentInput) => {
  const { metadata } = input;
  const expression = metadata.expression;
  const canonicalExpression =
    expression?.type === "identified"
      ? {
          type: expression.type,
          language: expression.language,
          revision: statedValue(expression.revision),
        }
      : expression?.type;
  const stage = metadata.stage;
  const canonicalStage =
    stage?.state === "adopted" || stage?.state === "consultation"
      ? {
          state: stage.state,
          evidence: {
            url: stage.evidence.url,
            quote: stage.evidence.quote,
            locator: stage.evidence.locator,
          },
        }
      : stage?.state;
  const canonical = {
    title: metadata.title,
    kind: metadata.kind,
    ...(metadata.sourceKind ? { sourceKind: metadata.sourceKind } : {}),
    ...(metadata.sourceDocumentId
      ? { sourceDocumentId: metadata.sourceDocumentId }
      : {}),
    reference:
      metadata.statedReference.state === "stated"
        ? metadata.statedReference.value
        : null,
    issuedOn:
      metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
    validityState: metadata.validity.state,
    validityBasis: metadata.validity.basis,
    ...(metadata.expression ? { expression: canonicalExpression } : {}),
    ...(metadata.stage ? { stage: canonicalStage } : {}),
    ...(metadata.relations
      ? {
          relations: metadata.relations
            .map(({ type, reference, evidence: { url, quote, locator } }) => ({
              type,
              reference,
              evidence: { url, quote, locator },
            }))
            .toSorted((left, right) =>
              compareCanonicalKeys(JSON.stringify(left), JSON.stringify(right)),
            ),
        }
      : {}),
  };
  const raw = input.raw
    .filter((part) => part.purpose !== "discovery")
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
