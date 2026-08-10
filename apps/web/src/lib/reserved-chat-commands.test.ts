import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  getReservedChatCommands,
  matchReservedChatCommand,
  runReservedChatCommand,
} from "@/lib/reserved-chat-commands";
import type {
  ReservedChatCommandHandlers,
  ReservedChatCommandId,
} from "@/lib/reserved-chat-commands";

// bun:test has no DOM. Substitute the browser's `DOMParser` with a minimal
// stand-in mirroring the two behaviours the matcher relies on — tag stripping
// and entity decoding. Decoding itself is the platform's job in production;
// these tests cover our matching over the decoded text. Tags are stripped to
// a fixed point: the stub is not a sanitizer, but iterating keeps CodeQL's
// incomplete-multi-character-sanitization check satisfied about the pattern.
class DOMParserStub {
  parseFromString(html: string, _type: string) {
    let stripped = html;
    let previous;
    do {
      previous = stripped;
      stripped = stripped.replaceAll(/<[^>]*>/gu, "");
    } while (stripped !== previous);
    const textContent = stripped
      .replaceAll("&#x2F;", "/")
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&");
    return { body: { textContent } };
  }
}

beforeAll(() => {
  Object.assign(globalThis, { DOMParser: DOMParserStub });
});

afterAll(() => {
  // SAFETY: removes the test-only global installed above.
  delete (globalThis as { DOMParser?: unknown }).DOMParser;
});

const collectHandlers = () => {
  const calls: ReservedChatCommandId[] = [];
  const handlers: ReservedChatCommandHandlers = {
    new: () => {
      calls.push("new");
    },
    "rename-chat": () => {
      calls.push("rename-chat");
    },
  };
  return { calls, handlers };
};

describe("getReservedChatCommands", () => {
  test("offers /rename-chat only alongside a persisted thread", () => {
    expect(
      getReservedChatCommands({ hasPersistedThread: false }).map((c) => c.id),
    ).toEqual(["new"]);
    expect(
      getReservedChatCommands({ hasPersistedThread: true }).map((c) => c.id),
    ).toEqual(["new", "rename-chat"]);
  });
});

describe("runReservedChatCommand", () => {
  test("dispatches each declared command exactly once (both directions)", () => {
    // The declared command set and the exercised handler set must coincide:
    // a command with no handler would not compile (the record is total), and
    // a handler for a nonexistent command would be dead code.
    const declared = getReservedChatCommands({ hasPersistedThread: true }).map(
      (c) => c.id,
    );
    const { calls, handlers } = collectHandlers();
    expect(Object.keys(handlers).toSorted()).toEqual(declared.toSorted());

    for (const command of getReservedChatCommands({
      hasPersistedThread: true,
    })) {
      expect(
        runReservedChatCommand(`<p>${command.command}</p>`, handlers),
      ).toBe(true);
    }
    expect(calls.toSorted()).toEqual(declared.toSorted());
  });

  test("matches an unavailable command so its handler can explain itself", () => {
    // Availability gates the slash menu, not the dispatch: typing
    // /rename-chat by hand on a composer that cannot rename must reach the
    // declared handler (which clears the composer and toasts), never the
    // model as literal prompt text.
    const { calls, handlers } = collectHandlers();
    expect(runReservedChatCommand("<p>/rename-chat</p>", handlers)).toBe(true);
    expect(calls).toEqual(["rename-chat"]);
  });

  test("decodes entity-encoded composer HTML before matching", () => {
    const { calls, handlers } = collectHandlers();
    expect(runReservedChatCommand("<p>&#x2F;rename-chat</p>", handlers)).toBe(
      true,
    );
    expect(calls).toEqual(["rename-chat"]);
  });

  test("returns false for ordinary prompts and runs no handler", () => {
    const { calls, handlers } = collectHandlers();
    expect(runReservedChatCommand("<p>Draft an NDA</p>", handlers)).toBe(false);
    // A command mentioned mid-sentence is a prompt, not a command.
    expect(
      runReservedChatCommand("<p>use /rename-chat for this</p>", handlers),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  test("passes trailing text to the handler as args", () => {
    const seen: string[] = [];
    const handlers: ReservedChatCommandHandlers = {
      new: () => {
        throw new Error("wrong handler");
      },
      "rename-chat": (args) => {
        seen.push(args);
      },
    };
    expect(
      runReservedChatCommand(
        "<p>/rename-chat  Quarterly NDA review </p>",
        handlers,
      ),
    ).toBe(true);
    expect(seen).toEqual(["Quarterly NDA review"]);
  });
});

describe("matchReservedChatCommand", () => {
  test("trims surrounding whitespace", () => {
    expect(matchReservedChatCommand("<p> /new </p>")?.command.id).toBe("new");
  });

  test("matches the bare command with empty args", () => {
    expect(matchReservedChatCommand("<p>/rename-chat</p>")).toMatchObject({
      args: "",
      command: { id: "rename-chat" },
    });
  });

  test("requires a whitespace boundary after the command token", () => {
    // A longer word sharing a command prefix is a prompt, not a command.
    expect(matchReservedChatCommand("<p>/newest gadgets</p>")).toBeNull();
    expect(matchReservedChatCommand("<p>/rename-chats</p>")).toBeNull();
  });
});
