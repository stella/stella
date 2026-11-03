import { Result } from "better-result";

import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";

type PublisherUrlOptions = {
  value: string;
  /** The publisher's own origin; a link elsewhere is refused. */
  origin: string;
  base?: string;
  /** Names the publisher in the refusal. */
  publisher: string;
};

/**
 * Resolves a publisher link against its origin, refusing other origins,
 * credentials, fragments and encoded path separators.
 */
export const publisherUrl = ({
  value,
  origin,
  base = origin,
  publisher,
}: PublisherUrlOptions) =>
  Result.gen(function* () {
    const parsed = Result.try(() => new URL(value, base));
    if (
      parsed.isErr() ||
      parsed.value.origin !== origin ||
      parsed.value.username ||
      parsed.value.password ||
      parsed.value.hash ||
      /%2f|%5c|\\/iu.test(parsed.value.pathname)
    ) {
      return yield* Result.err(
        new SoftLawIngestionError({
          message: `Invalid ${publisher} publisher locator`,
        }),
      );
    }
    return Result.ok(parsed.value.href);
  });
