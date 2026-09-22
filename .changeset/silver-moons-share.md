---
"@stll/ai-catalog": minor
---

Declare per-model streaming tool-use support. `MODEL_STREAMING_TOOL_USE` is
total over the offered catalog and `supportsStreamingToolUse` reads it;
`us.deepseek.r1-v1:0` on Bedrock is the first model marked unsupported,
because Converse refuses any streaming request that carries a toolConfig for
it. Unlisted ids stay tool-capable.
