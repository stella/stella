import { describe, expect, test } from "bun:test";

import {
  createS3CredentialGuard,
  isExpiredCredentialsError,
} from "@/api/lib/s3/credential-guard";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const CREDENTIAL_LIFETIME_MS = 6 * 60 * 60 * 1000;

/**
 * An ECS task role as the container endpoint serves it: a credential set with
 * a real expiry, rotated on request, and a clock the test moves by hand. The
 * guard is built over this rather than over a mock, so what the tests assert
 * is when a rebuild happens relative to expiry, not that a function was called.
 */
const createFakeCredentialSource = () => {
  let now = 0;
  let expiresAt: number | null = null;
  let builds = 0;

  return {
    advanceMs: (milliseconds: number): void => {
      now += milliseconds;
    },
    get builds(): number {
      return builds;
    },
    lifecycle: {
      isStale: (): boolean =>
        expiresAt === null || now >= expiresAt - REFRESH_MARGIN_MS,
      refresh: async (): Promise<void> => {
        await Promise.resolve();
        builds += 1;
        expiresAt = now + CREDENTIAL_LIFETIME_MS;
      },
    },
  };
};

const expiredTokenError = (): Error =>
  Object.assign(new Error("The provided token has expired."), {
    name: "ExpiredToken",
  });

describe("createS3CredentialGuard", () => {
  test("rebuilds the client before the credentials expire", async () => {
    const source = createFakeCredentialSource();
    const guard = createS3CredentialGuard(source.lifecycle);

    await guard.run(async () => await Promise.resolve("first"));
    expect(source.builds).toBe(1);

    // Mid-life: the captured credentials still sign, so nothing is rebuilt.
    source.advanceMs(CREDENTIAL_LIFETIME_MS / 2);
    await guard.run(async () => await Promise.resolve("second"));
    expect(source.builds).toBe(1);

    // Inside the refresh margin, and so before the token the process is
    // holding stops being accepted.
    source.advanceMs(CREDENTIAL_LIFETIME_MS / 2 - REFRESH_MARGIN_MS + 1);
    await guard.run(async () => await Promise.resolve("third"));
    expect(source.builds).toBe(2);
  });

  test("an expired-token failure refreshes once and replays the operation", async () => {
    const source = createFakeCredentialSource();
    const guard = createS3CredentialGuard(source.lifecycle);
    let attempts = 0;

    // The rotation this guard exists for: the endpoint retired the credential
    // set between the staleness check and the request, so a client that looked
    // fresh signs with a token the service refuses.
    const written = await guard.run(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw expiredTokenError();
      }
      return await Promise.resolve("written");
    });

    expect(written).toBe("written");
    expect(attempts).toBe(2);
    // The initial build plus exactly one forced rebuild.
    expect(source.builds).toBe(2);
  });

  test("a second expired-token failure reaches the caller", async () => {
    const source = createFakeCredentialSource();
    const guard = createS3CredentialGuard(source.lifecycle);
    const failures: Error[] = [];
    let attempts = 0;

    const rejection = await guard
      .run(async () => {
        attempts += 1;
        await Promise.resolve();
        const failure = expiredTokenError();
        failures.push(failure);
        throw failure;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // Retrying past this would spin against a credential source that is not
    // the problem; the caller has to hear about the replay's own failure.
    expect(rejection).toBe(failures.at(1));
    expect(attempts).toBe(2);
    expect(source.builds).toBe(2);
  });

  test("a failure that is not a credential expiry is not retried", async () => {
    const source = createFakeCredentialSource();
    const guard = createS3CredentialGuard(source.lifecycle);
    const refused = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
    });
    let attempts = 0;

    const rejection = await guard
      .run(async () => {
        attempts += 1;
        await Promise.resolve();
        throw refused;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The store's own error object, not a copy of it: callers downstream match
    // on the SDK's error name to tell an absent object from an unreachable one.
    expect(rejection).toBe(refused);
    expect(attempts).toBe(1);
    expect(source.builds).toBe(1);
  });

  test("concurrent operations share one rebuild", async () => {
    const source = createFakeCredentialSource();
    const guard = createS3CredentialGuard(source.lifecycle);

    // Credential resolution reaches the network. Five writers starting at once
    // on a cold process must cost one resolution, not five.
    await Promise.all(
      Array.from(
        { length: 5 },
        async () => await guard.run(async () => await Promise.resolve("ok")),
      ),
    );

    expect(source.builds).toBe(1);
  });

  test("a failed rebuild is not cached", async () => {
    let attempts = 0;
    const guard = createS3CredentialGuard({
      isStale: () => true,
      refresh: async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts === 1) {
          throw new Error("credential endpoint unreachable");
        }
      },
    });

    const rejection = await guard.refreshStale().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);

    // A cached rejection would replay one transient endpoint failure to every
    // later operation for the life of the process.
    await guard.refreshStale();
    expect(attempts).toBe(2);
  });
});

describe("isExpiredCredentialsError", () => {
  const expired = [
    Object.assign(new Error("The provided token has expired."), {
      name: "ExpiredToken",
    }),
    Object.assign(new Error("boom"), { code: "ExpiredToken" }),
    Object.assign(new Error("boom"), { name: "ExpiredTokenException" }),
    Object.assign(new Error("boom"), { code: "RequestExpired" }),
    Object.assign(new Error("boom"), { name: "TokenRefreshRequired" }),
    // Unmodeled by the SDK: the service sentence is all that survives.
    Object.assign(new Error("The provided token has expired."), {
      name: "S3ServiceException",
    }),
  ];

  // Credentials that are wrong rather than old. A rebuild resolves the same
  // source and the request is refused again, so retrying only delays the
  // failure the caller has to see.
  const notExpired = [
    Object.assign(new Error("boom"), { name: "InvalidAccessKeyId" }),
    Object.assign(new Error("boom"), { name: "SignatureDoesNotMatch" }),
    Object.assign(new Error("The security token is invalid."), {
      name: "InvalidToken",
    }),
    Object.assign(new Error("boom"), { name: "AccessDenied" }),
    new Error("socket hang up"),
    null,
    undefined,
    "ExpiredToken",
  ];

  test("recognises an expired credential set", () => {
    expect(expired.map(isExpiredCredentialsError)).toEqual(
      expired.map(() => true),
    );
  });

  test("does not treat a rejected credential as an expired one", () => {
    expect(notExpired.map(isExpiredCredentialsError)).toEqual(
      notExpired.map(() => false),
    );
  });
});
