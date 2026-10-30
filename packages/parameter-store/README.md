# @stll/parameter-store

`readParameter` reads one deployment parameter by name and returns a `Result`
containing its value and version. The caller selects whether to decrypt secure
strings and may supply an abort signal. Each read has a five-second deadline.

Failures expose `not_found`, `access_denied`, `timeout`, or `unavailable` reasons;
provider messages and parameter values are omitted from errors. Tests inject a
client and make no network calls. Grant parsing and refresh scheduling belong to
the API.
