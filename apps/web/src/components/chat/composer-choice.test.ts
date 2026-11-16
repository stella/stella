import { Result, TaggedError } from "better-result";
import { expect, test } from "bun:test";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";

import {
  type ComposerChoice,
  ComposerChoiceSuperseded,
  createComposerChoice,
} from "./composer-choice";

class WriteRefused extends TaggedError("WriteRefused")<{ message: string }> {}

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};
const CLOUD_MODEL = "openai::gpt-5";
const STORED: ComposerChoice = {
  model: null,
  reasoningEffort: null,
  runTarget: CHAT_CLOUD_RUN_TARGET,
};

/**
 * An owner whose writes wait until the test answers them, in the order they
 * were sent, with a server that stores what each accepted write carried.
 */
const harness = () => {
  const sent: {
    choice: ComposerChoice;
    answer: PromiseWithResolvers<Result<void, WriteRefused>>;
  }[] = [];
  const arrived: PromiseWithResolvers<undefined>[] = [];
  const stored: ComposerChoice[] = [];
  const failures: WriteRefused[] = [];
  const server = { choice: STORED };
  let refetches = 0;
  const owner = createComposerChoice<WriteRefused>({
    write: async (choice) => {
      const answer = Promise.withResolvers<Result<void, WriteRefused>>();
      sent.push({ choice, answer });
      arrived.shift()?.resolve(undefined);
      const result = await answer.promise;
      if (Result.isOk(result)) {
        server.choice = choice;
      }
      return result;
    },
    stored: (choice) => {
      stored.push(choice);
    },
    refetch: async () => {
      refetches += 1;
      stored.push(server.choice);
      await Promise.resolve();
    },
    failed: (error) => {
      failures.push(error);
    },
  });
  /** The `index`th write, once the owner has sent it. */
  const write = async (index: number) => {
    if (sent.length <= index) {
      const next = Promise.withResolvers<undefined>();
      arrived.push(next);
      await next.promise;
    }
    return sent[index] ?? panicMissing(index);
  };
  return {
    owner,
    sent,
    stored,
    failures,
    server,
    write,
    refetches: () => refetches,
  };
};

const panicMissing = (index: number): never => {
  throw new Error(`write ${String(index)} was never sent`);
};

const ok = () => Result.ok(undefined);
const refused = () =>
  Result.err(new WriteRefused({ message: "The server refused the choice" }));

test("a run target picked while a model is still being written keeps that model", async () => {
  const { owner, write } = harness();
  owner.pick(STORED, { model: CLOUD_MODEL, reasoningEffort: null });
  owner.pick(STORED, { runTarget: CODEX });

  const first = await write(0);
  expect(first.choice).toEqual({ ...STORED, model: CLOUD_MODEL });
  first.answer.resolve(ok());
  const second = await write(1);
  expect(second.choice).toEqual({
    model: CLOUD_MODEL,
    reasoningEffort: null,
    runTarget: CODEX,
  });
  second.answer.resolve(ok());
  expect(await owner.settled()).toEqual(ok());
  expect(owner.desired()).toBeNull();
});

test("the menus read the run target picked while its write is still pending", async () => {
  const { owner, write } = harness();
  owner.pick(STORED, { runTarget: CODEX });
  expect(owner.desired()?.runTarget).toEqual(CODEX);

  (await write(0)).answer.resolve(ok());
  await owner.settled();
  expect(owner.desired()).toBeNull();
});

test("every stored write lands in order, and a failed one shows what the server stores", async () => {
  const { owner, write, stored, failures, refetches } = harness();
  owner.pick(STORED, { runTarget: CODEX });
  owner.pick(STORED, { model: CLOUD_MODEL, reasoningEffort: null });

  (await write(0)).answer.resolve(ok());
  const second = await write(1);
  // The newer pick carries the run target the older one is storing.
  expect(second.choice.runTarget).toEqual(CODEX);
  second.answer.resolve(refused());

  const settled = await owner.settled();
  expect(Result.isError(settled)).toBe(true);
  expect(refetches()).toBe(1);
  // The first write landed although a newer one existed; the reread shows
  // what the server holds: the computer, without the refused model.
  expect(stored).toEqual([
    { ...STORED, runTarget: CODEX },
    { ...STORED, runTarget: CODEX },
  ]);
  expect(owner.desired()).toBeNull();
  expect(failures).toHaveLength(1);
});

test("picks queued behind a failed write are dropped and their sends refused", async () => {
  const { owner, write, sent } = harness();
  owner.pick(STORED, { runTarget: CODEX });
  owner.pick(STORED, { model: CLOUD_MODEL, reasoningEffort: null });

  (await write(0)).answer.resolve(refused());
  const settled = await owner.settled();
  expect(
    Result.isError(settled) && ComposerChoiceSuperseded.is(settled.error),
  ).toBe(true);
  expect(sent).toHaveLength(1);
  expect(owner.desired()).toBeNull();
});

test("a pick made after a failure is written as usual", async () => {
  const { owner, write } = harness();
  owner.pick(STORED, { runTarget: CODEX });
  (await write(0)).answer.resolve(refused());
  await owner.settled();

  owner.pick(STORED, { runTarget: CODEX });
  (await write(1)).answer.resolve(ok());
  expect(await owner.settled()).toEqual(ok());
});
