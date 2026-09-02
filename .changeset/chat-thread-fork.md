---
"@stll/cli": minor
---

Expose the chat thread fork endpoint. `POST /chat/threads/:threadId/fork` copies
a thread's history up to a chosen message into a new thread, so the route map
and capability catalog now carry it.
