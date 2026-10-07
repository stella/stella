# Private SHA-256 helpers

Private workspaces select the Bun, Node or browser entry point for their runtime. Published packages own their hashing locally.

The helpers preserve input bytes, UTF-8 encoding, update order and digest encodings. Bun and Node entry points provide synchronous hexadecimal, base64, base64url and bytes plus incremental hashing. The browser entry point provides asynchronous hexadecimal and bytes through WebCrypto. The root entry point converts hexadecimal and base64 checksum representations.

The SHA-256 confinement rule registers each raw-primitive owner by filename. Migration exemptions are reasoned, enumerated and shrink-only.
