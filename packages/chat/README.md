# `@stll/chat`

Portable React chat primitives: message streams, model selectors, composer
action resolution, and observable streaming runtimes.

The host owns authentication, endpoint selection, persistence, provider
credentials, translations, and rich-message rendering. It supplies a typed
`ChatTransport`; the package never reads environment variables or silently
selects a provider.

```tsx
import { ChatMessageStream, createChatRuntime } from "@stll/chat";

const runtime = createChatRuntime({ transport });
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
