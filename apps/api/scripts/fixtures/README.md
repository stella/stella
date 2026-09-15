# Native image canary

`native-image-canary.heic` is an 800 × 300 synthetic image containing only
`K7M4P9`, drawn in black on white. It contains no legal or personal data.
The same HEIF container is sent under `image/heic` and `image/heif`; neither
case performs server-side conversion.

Created with Pillow (Arial Bold, 100 px, centered) and Bun 1.4.2's macOS
system HEIC encoder at quality 95. The committed bytes let the Linux canary
run without an HEIC decoder or encoder. The expected token is deliberately
absent from the model prompt and output schema.

The canary checks actual reading through the application adapter, structured
output, and Table's image-message builder. An HTTP success alone is insufficient.
Reports record the fixture hash, adapter version, Git revision, and runner hash.
Changing the meaning of the probe requires a new probe version and fresh evidence.
