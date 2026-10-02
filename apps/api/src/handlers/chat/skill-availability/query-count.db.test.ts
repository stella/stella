import { getSessionCookie } from "better-auth/cookies";
import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { chatRoute } from "@/api/handlers/chat/routes";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { createHumanSession } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

/**
 * The composer menus ask for skill availability on every chat page, and the
 * route-smoke network baseline budgets its statements. The count is the
 * request's own fixed plan: the same on the first call and every later one,
 * and the same for each of several calls in flight at once.
 *
 * Sign-in leaves the signed session snapshot cookie, so auth reads no session
 * row: member role and AI settings (2). The handler reads the caller's skills,
 * then the chat tool inputs a built-in skill's required tools are decided
 * over: tool overrides, matters, web-search keys and registry credentials,
 * each in its own scoped transaction (5 x 2).
 */
const WITH_SESSION_SNAPSHOT = 12;
/**
 * Without the snapshot cookie auth checks the live session row and reads its
 * user (2). The first such call also records the session's activity; later
 * calls inside the write interval skip that write.
 */
const WITHOUT_SESSION_SNAPSHOT = WITH_SESSION_SNAPSHOT + 2;
const SESSION_ACTIVITY_WRITE = 1;
const CONCURRENT_CALLS = 4;

setDefaultTimeout(120_000);

beforeAll(async () => {
  await initAgentAuthTestDb({ logger: queryCountLogger });
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const countQueries = async (headers: HeadersInit) =>
  await runWithQueryCounter(async (counter) => {
    const response = await chatRoute.handle(
      new Request("http://localhost/chat/skill-availability", {
        headers,
      }),
    );
    expect(response.status).toBe(200);
    return counter.count;
  });

describe("skill availability runs a fixed query plan", () => {
  test("the first call and every later one issue the same statements", async () => {
    const { cookieHeader } = await createHumanSession({
      email: `skill-queries-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Skill queries",
      orgSlugPrefix: "skill-queries",
    });
    expect(cookieHeader).toContain("session_data=");

    const sequential = [];
    for (const _call of [1, 2, 3]) {
      sequential.push(await countQueries({ cookie: cookieHeader }));
    }
    expect(sequential).toEqual([
      WITH_SESSION_SNAPSHOT,
      WITH_SESSION_SNAPSHOT,
      WITH_SESSION_SNAPSHOT,
    ]);

    const concurrent = await Promise.all(
      Array.from(
        { length: CONCURRENT_CALLS },
        async () => await countQueries({ cookie: cookieHeader }),
      ),
    );
    expect(concurrent).toEqual(
      Array.from({ length: CONCURRENT_CALLS }, () => WITH_SESSION_SNAPSHOT),
    );
  });

  test("a call without the session snapshot adds only the session reads and one activity write", async () => {
    const { cookieHeader } = await createHumanSession({
      email: `skill-queries-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Skill queries",
      orgSlugPrefix: "skill-queries",
    });
    const withoutSnapshot = cookieHeader
      .split("; ")
      .filter((pair) => !pair.includes("session_data="))
      .join("; ");
    expect(withoutSnapshot).not.toBe(cookieHeader);

    expect(await countQueries({ cookie: withoutSnapshot })).toBe(
      WITHOUT_SESSION_SNAPSHOT + SESSION_ACTIVITY_WRITE,
    );
    expect(await countQueries({ cookie: withoutSnapshot })).toBe(
      WITHOUT_SESSION_SNAPSHOT,
    );
    expect(await countQueries({ cookie: withoutSnapshot })).toBe(
      WITHOUT_SESSION_SNAPSHOT,
    );
  });

  test("bearer calls add only the session reads and one activity write", async () => {
    const { cookieHeader } = await createHumanSession({
      email: `skill-queries-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Skill queries",
      orgSlugPrefix: "skill-queries",
    });
    const credential =
      getSessionCookie(new Headers({ cookie: cookieHeader })) ??
      panic("Session fixture missing");
    const headers = { authorization: `Bearer ${credential}` };
    expect(await countQueries(headers)).toBe(
      WITHOUT_SESSION_SNAPSHOT + SESSION_ACTIVITY_WRITE,
    );
    expect(await countQueries(headers)).toBe(WITHOUT_SESSION_SNAPSHOT);
    expect(await countQueries(headers)).toBe(WITHOUT_SESSION_SNAPSHOT);
  });
});
