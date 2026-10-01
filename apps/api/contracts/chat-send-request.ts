import { expectTypeOf } from "bun:test";

import type { ChatSendRequest as PortableChatSendRequest } from "@stll/api-contract";

import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";

expectTypeOf<ChatSendRequest>().toExtend<PortableChatSendRequest>();
expectTypeOf<PortableChatSendRequest>().toExtend<ChatSendRequest>();
