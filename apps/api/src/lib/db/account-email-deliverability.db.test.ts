import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  markAccountEmailUndeliverable,
  readAccountEmailUndeliverable,
} from "@/api/lib/db/account-row";
import { sendNewDeviceLoginEmail } from "@/api/lib/email/email";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

afterEach(() => {
  resetLogSinkForTesting();
});

const at = new Date("2026-10-26T03:37:41.000Z");

const newAccount = async () => {
  const browser = await signInHuman(
    `deliverability-${Bun.randomUUIDv7()}@example.test`,
  );
  return { userId: browser.userId, email: normalizeEmail(browser.email) };
};

describe("account email deliverability", () => {
  test("the first refusal of an account's address stands until the address changes", async () => {
    const account = await newAccount();
    expect(
      await readAccountEmailUndeliverable(rootDb, account.email),
    ).toBeUndefined();

    expect(
      await markAccountEmailUndeliverable({
        database: rootDb,
        email: account.email,
        reason: "suppressed",
        at,
      }),
    ).toBe(true);
    // A later refusal of the same address keeps the first reason and time.
    expect(
      await markAccountEmailUndeliverable({
        database: rootDb,
        email: account.email,
        reason: "complaint",
        at: new Date(),
      }),
    ).toBe(false);
    expect(await readAccountEmailUndeliverable(rootDb, account.email)).toEqual({
      userId: account.userId,
      reason: "suppressed",
    });
    const [stored] = await rootDb
      .select({ at: user.emailUndeliverableAt })
      .from(user)
      .where(eq(user.id, account.userId));
    expect(stored?.at).toEqual(at);

    // A new address is deliverable: the refusal named the old one.
    const changed = normalizeEmail(
      `changed-${Bun.randomUUIDv7()}@example.test`,
    );
    await rootDb
      .update(user)
      .set({ email: changed })
      .where(eq(user.id, account.userId));
    expect(
      await readAccountEmailUndeliverable(rootDb, changed),
    ).toBeUndefined();
  });

  test("the database refuses a partial or unknown refusal state", async () => {
    const account = await newAccount();
    for (const state of [
      { emailUndeliverableAddress: account.email, emailUndeliverableAt: at },
      {
        emailUndeliverableAddress: account.email,
        emailUndeliverableReason: "hard_bounce",
      },
      { emailUndeliverableReason: "suppressed", emailUndeliverableAt: at },
      {
        emailUndeliverableAddress: account.email,
        emailUndeliverableReason: "bounced",
        emailUndeliverableAt: at,
      },
    ]) {
      const written = await Result.tryPromise(
        async () =>
          await rootDb
            .update(user)
            .set(state)
            .where(eq(user.id, account.userId)),
      );
      expect(written.isErr()).toBe(true);
    }
    expect(
      await readAccountEmailUndeliverable(rootDb, account.email),
    ).toBeUndefined();
  });

  test("an address no account uses changes nothing", async () => {
    expect(
      await markAccountEmailUndeliverable({
        database: rootDb,
        email: normalizeEmail(`nobody-${Bun.randomUUIDv7()}@example.test`),
        reason: "hard_bounce",
        at,
      }),
    ).toBe(false);
  });

  test("a send to a refused address is skipped with its reason and no address", async () => {
    const account = await newAccount();
    await markAccountEmailUndeliverable({
      database: rootDb,
      email: account.email,
      reason: "hard_bounce",
      at,
    });
    const records: LogRecord[] = [];
    setLogSinkForTesting((record) => {
      records.push(record);
    });

    // No transport is configured here: reaching it would throw.
    await sendNewDeviceLoginEmail({
      email: account.email,
      device: "Firefox on Linux",
      ipAddress: "192.0.2.1",
      time: "26 October 2026, 04:37",
      sessionsUrl: "https://app.example.test/settings/sessions",
      lang: "en",
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "email.send.skipped_undeliverable",
        }),
      ]),
    );
    const skipped = records.find(
      ({ message }) => message === "email.send.skipped_undeliverable",
    );
    expect(JSON.stringify(skipped)).toContain("hard_bounce");
    expect(JSON.stringify(records)).not.toContain(account.email);
  });
});
