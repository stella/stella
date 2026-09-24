# @stll/uuid-codec

Compacting a uuid to a 22-character base64url string for a URL segment, and
reading it back.

## What lives here

`encodeCompactUuid` and `decodeCompactUuid`, the one encoding every public
reader mints an id-form address with, and the tests that pin it. The encoding
is part of published URLs, so the byte-for-byte output is the contract: the
property tests hold it over every 16-byte id, and the example test pins the
exact pair the live links carry.

Invalid input is a typed failure (`InvalidUuidError`,
`InvalidCompactUuidError`), never a throw and never a silent fallback, so a
caller decides for itself whether an unreadable segment is a 404 or a value to
pass through untouched.

`decodeUuidSuffix` reads the id off the end of a `<prefix><separator><id>`
segment by its fixed length, because the base64url alphabet contains `-` and a
compact id can itself start with or contain the separator.

## What does not

Route shapes. Which prefix leads a segment, which separator precedes the id, and
what a reader does with an id it cannot resolve belong to the reader that owns
the route.

## License

Apache-2.0
