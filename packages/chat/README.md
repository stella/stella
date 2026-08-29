# `@stll/chat`

Portable React chat primitives: a rich-editor composer shell, message stream,
model selector, and observable streaming runtime.

The host owns authentication, endpoint selection, persistence, provider
credentials, translations, and rich-message rendering. It supplies a typed
`ChatTransport`; the package never reads environment variables or silently
selects a provider.

```tsx
import { ChatComposer, ChatMessageStream, createChatRuntime } from "@stll/chat";

const runtime = createChatRuntime({ transport });

<ChatComposer
  canSend={draft.length > 0}
  isGenerating={runtime.getSnapshot().isStreaming}
  labels={{ retry: "Retry", send: "Send", stop: "Stop" }}
  onSend={sendDraft}
>
  <RichEditor />
</ChatComposer>;
```

Validate every explicit provider/model selection with
`resolveChatModelSelection`. It rejects unknown, empty, duplicate, and
unconfigured provider/model combinations with `ChatConfigurationError`.
