import { describe, expect, test } from "bun:test";

import { CHAT_TRANSPORT_ERROR_CODE } from "@stll/anonymize-chat";

import { chatErrorTranslationKey } from "@/features/chat/chat-request-error";

const refusedWith = (code: string) =>
  new Error(JSON.stringify({ code, message: "refused" }));

describe("a send refused at the anonymized boundary", () => {
  test("says the agent on the member's computer is why, for a turn there", () => {
    expect(
      chatErrorTranslationKey(
        refusedWith(CHAT_TRANSPORT_ERROR_CODE.localRunAnonymizedRefusal),
      ),
    ).toBe("errors.apiCodes.localRunAnonymizedRefusal");
  });

  test("keeps the attachment copy for content stella cannot anonymize", () => {
    expect(
      chatErrorTranslationKey(
        refusedWith(CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal),
      ),
    ).toBe("chat.sendErrorAnonymizationBlocked");
  });
});
