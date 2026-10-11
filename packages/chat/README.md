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

For TanStack hosts, `@stll/chat/durable-transport` exports
`createDurableChatTransport`: pass its `connection` and `persistence` to
`ChatClient`, call `attach()` while a viewer is mounted and `detach()` when it
leaves. The host supplies authenticated probe/join URLs and transcript reload
callbacks. Resume state comes from the server; this adapter stores no transcript
on the device. Network retries rejoin the log with the last event cursor and
jittered backoff, bounded to three minutes. Detaching keeps an accepted server
turn running; the host must use the turn cancellation endpoint for Stop.
