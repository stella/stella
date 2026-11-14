---
"@stll/chat": patch
---

`createDurableChatTransport` gives each dropped connection its own reconnect window. A turn that stayed silent between two drops used to spend the first drop's window on the second and fail its reconnection.
