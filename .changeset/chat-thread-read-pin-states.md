---
"@stll/cli": patch
---

Add `chat.threads.read-state.update` and `chat.threads.pin-state.update`: mark one of your chats read or unread, and pin it to the top of your list or unpin it. `chat.threads.list` now says, for each chat, whether you have read its latest answer and whether you pinned it, and takes `pinState` to list only pinned or only unpinned chats.
