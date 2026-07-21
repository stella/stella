import { expectTypeOf } from "expect-type";

import type { ChatSendRequest as PortableChatSendRequest } from "@stll/api-contract";

import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";

expectTypeOf<ChatSendRequest>().toEqualTypeOf<PortableChatSendRequest>();
