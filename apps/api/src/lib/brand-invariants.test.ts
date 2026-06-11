import { test } from "bun:test";
import { expectTypeOf } from "expect-type";

import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { PromptSafeText, UntrustedText } from "@/api/lib/prompt-safety";
import type {
  ClientSecret,
  RefreshToken,
  Secret,
} from "@/api/lib/secret-brands";

// All assertions here are compile-time: if a refactor widens a brand
// back to a plain string (or merges two brand families), typecheck
// fails on this file instead of the protection silently disappearing
// at every call site.

test("SafeId is nominal, not a string alias", () => {
  expectTypeOf<string>().not.toExtend<SafeId<"user">>();
  expectTypeOf<SafeId<"user">>().toExtend<string>();
});

test("SafeId brands do not cross entity types", () => {
  expectTypeOf<SafeId<"user">>().not.toExtend<SafeId<"workspace">>();
  expectTypeOf<SafeId<"workspace">>().not.toExtend<SafeId<"organization">>();
});

test("SafeId constructors return the requested brand", () => {
  expectTypeOf(toSafeId<"workspace">("id")).toEqualTypeOf<
    SafeId<"workspace">
  >();
  expectTypeOf(createSafeId<"entity">()).toEqualTypeOf<SafeId<"entity">>();
});

test("Secret is nominal and kinds do not cross", () => {
  expectTypeOf<string>().not.toExtend<Secret<"ApiKey">>();
  expectTypeOf<RefreshToken>().not.toExtend<ClientSecret>();
  expectTypeOf<ClientSecret>().not.toExtend<RefreshToken>();
});

test("SafeId and Secret families cannot cross-assign", () => {
  expectTypeOf<SafeId<"user">>().not.toExtend<Secret<"ApiKey">>();
  expectTypeOf<Secret<"ApiKey">>().not.toExtend<SafeId<"user">>();
});

test("prompt-safety brands separate untrusted from safe text", () => {
  expectTypeOf<string>().not.toExtend<PromptSafeText>();
  expectTypeOf<string>().not.toExtend<UntrustedText>();
  expectTypeOf<UntrustedText>().not.toExtend<PromptSafeText>();
  expectTypeOf<PromptSafeText>().not.toExtend<UntrustedText>();
});

test("chat tools only accept verified workspace id lists", () => {
  expectTypeOf<
    SafeId<"workspace">[]
  >().not.toExtend<AuthorizedToolWorkspaceIds>();
  expectTypeOf<string[]>().not.toExtend<AuthorizedToolWorkspaceIds>();
});
