import { expect, test } from "bun:test";

import type { StoredSession } from "@/connection/session";
import { createSessionEndBoundary } from "@/connection/session-end";
import type { DraftScope } from "@/native/dictation-recorder";

import { dictationSessionEndHandler } from "./lifecycle";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com:443",
  userId: "user-žofie",
  issuer: "https://stella.example.com/api/auth",
  clientId: "mobile",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "rotated-grant",
};
const key = ({ serverOrigin, userId }: DraftScope) =>
  JSON.stringify([serverOrigin, userId]);
const scope = {
  serverOrigin: "https://stella.example.com",
  userId: SESSION.userId,
};

for (const reason of ["signed-out", "ended"] as const) {
  test(`${reason} saves the ending account's recording before the session flips`, async () => {
    const otherUser = { ...scope, userId: "user-ľubica" };
    const otherServer = { ...scope, serverOrigin: "https://other.example.com" };
    const drafts = new Map([
      [key(scope), { status: "recording", audio: "Žofiina nahrávka" }],
      [key(otherUser), { status: "paused", audio: "Ľubicina nahrávka" }],
      [key(otherServer), { status: "paused", audio: "Iný server" }],
    ]);
    const boundary = createSessionEndBoundary();
    const unregister = boundary.register(
      dictationSessionEndHandler({
        recorderFor: (endingScope) => ({
          suspend: async () => {
            const draft = drafts.get(key(endingScope));
            expect(draft).toBeDefined();
            if (draft !== undefined) {
              draft.status = "paused";
            }
          },
        }),
        onFailure: () => {
          throw new TypeError("Unexpected suspension failure");
        },
      }),
    );
    await boundary.run(reason, SESSION);
    expect(drafts.get(key(scope))).toEqual({
      status: "paused",
      audio: "Žofiina nahrávka",
    });
    expect(drafts.get(key(otherUser))).toEqual({
      status: "paused",
      audio: "Ľubicina nahrávka",
    });
    expect(drafts.get(key(otherServer))).toEqual({
      status: "paused",
      audio: "Iný server",
    });
    unregister();
  });
}

test("a timed-out session handler leaves journaled audio recoverable on the next sign-in", async () => {
  const persisted = new Map([[key(scope), "Diktát Žofie Černé"]]);
  let finishSuspension: () => void = () => {
    throw new TypeError("Suspension never started");
  };
  const pending = new Promise<void>((resolve) => {
    finishSuspension = resolve;
  });
  let finished = false;
  const boundary = createSessionEndBoundary(1);
  boundary.register(
    dictationSessionEndHandler({
      recorderFor: () => ({
        suspend: async () => {
          await pending;
          finished = true;
        },
      }),
      onFailure: () => {
        throw new TypeError("Timeout is handled by the session boundary");
      },
    }),
  );
  await boundary.run("signed-out", SESSION);
  expect(finished).toBe(false);
  expect(persisted.get(key(scope))).toBe("Diktát Žofie Černé");
  expect(
    persisted.get(key({ ...scope, userId: "user-ľubica" })),
  ).toBeUndefined();
  finishSuspension();
  await pending;
  expect(finished).toBe(true);
});

test("suspension faults are surfaced while the session can still end", async () => {
  const failures: string[] = [];
  const boundary = createSessionEndBoundary();
  boundary.register(
    dictationSessionEndHandler({
      recorderFor: () => ({
        suspend: async () => {
          throw new TypeError("Storage unavailable");
        },
      }),
      onFailure: (error) => {
        failures.push(error._tag);
      },
    }),
  );
  await boundary.run("ended", SESSION);
  expect(failures).toEqual(["DictationSuspensionError"]);
});
