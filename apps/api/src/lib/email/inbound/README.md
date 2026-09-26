# Inbound correspondence

`receiveInboundMail` takes RFC 822 bytes, the SMTP envelope, a receipt timestamp,
verifier and trusted virus verdict. It files into the existing correspondence
model. SMTP recipients, rather than message To/Cc headers, resolve the matter.
Addresses use 32 random bytes encoded as 64 lowercase hexadecimal characters.

## Trust and attribution

- The root `mailauth/nodemailer` resolution replaces mailauth 5.0.3's vulnerable
  address parser with Nodemailer 9.1.0 (GHSA-2x7j-588g-ccc2). Remove this resolution
  when mailauth itself pins a patched version; it must not pin a later major back.
- The local verifier evaluates SPF, DKIM and DMARC against DNS using the supplied
  SMTP peer, HELO and MAIL FROM. Received and Authentication-Results message
  headers cannot authorize a delivery. A passing DMARC result must also have an
  aligned passing SPF or DKIM identifier.
- Provider verdicts are out-of-band metadata. Authenticate the notification
  publisher before calling `receiveSesInboundMail`. Configure its allowed S3
  bucket and key prefix; the adapter verifies both before fetching bytes.
- A verified primary address or verified alias requires current matter access.
  An approved shared mailbox requires current organization or matter scope.
  Its filer is the mailbox; documents have no human creator. The approval's
  administrator is never substituted as the filer or document creator.
- Delivery authentication stays bound to the outer sender. `intake` distinguishes
  direct mail, inline forwards and attached originals; extracted headers are the
  forwarder's assertions. An attached original's DKIM signature is checked against
  its exact decoded bytes with bounded DNS access. A verified signature identifies
  its signing domain, not an authenticated original author. Unsigned, invalid or
  partially signed originals remain unverified. Unavailable DNS or an exhausted
  verification budget also leaves this optional proof unverified.
- Threaded replies retain the member's complete message and quoted history.
  Ambiguous quoted headers do not trigger extraction. Invalid or timezone-free
  Date headers have an unknown sent time; explicitly zoned dates normalize to UTC.
- The owner phase resolves only the exact token and locks the verified auth
  account. Filing runs as the scoped database role with the resolved tenant and
  matter. The token lookup policy is constrained to the owner and exact token;
  no owner write policy is required.

## Delivery lifecycle

Retain the raw source and queue delivery until the receiver returns success.
A successful `dropped` result is terminal and should be acknowledged silently.
Do not bounce, reply, or expose acceptance details to the sender. A Result error
means the transport must retry with the same source. Use a bounded queue retry
policy and retain exhausted deliveries for operator repair; never acknowledge a
failed filing. The development command leaves source-file retention to its caller.

The record and each filer converge under unique keys. Matching extracts forwarded
by colleagues share one record, retaining the initial delivery's authentication
and recording each distinct filer. Intake is part of the key, so a direct delivery
cannot merge with an extracted original. Attachment completion
commits each document and ordinal link atomically through `createEntityFromBuffer`.
A replay resumes missing ordinals, including after an uncertain commit. MIME parts
are sorted by their content fingerprint, so reordered deliveries converge. A
partially completed record can be visible while its transport retries attachments.
The existing storage intent reconciler handles abandoned object writes; native
extraction and derivative repair retain their existing durable recovery paths.

Receipt-level virus verdicts fail closed. The existing upload scanner additionally
checks attachment content before persistence. A transient delivery verifier or
scanner failure is retryable. Provider GRAY/unknown authentication results do not prove
alignment and are rejected. Provider integration must supply definitive verdicts.

Rejected deliveries retain only sender, receipt time and a reason, once per
matter/source digest. Matter members can read these through the bounded endpoint
`GET /workspaces/:workspaceId/correspondence/drops`. Authentication failures include
`configure_sender_spf_dkim_dmarc` as a setup hint. No subject or body is stored in
this log. Unknown tokens have no matter in which to retain a log.
Oversized provider objects stop streaming at the limit and become terminal
`message_too_large` drops. Their provider object identity supplies the replay key
because a complete content digest cannot be read within the limit. A failed drop
write remains retryable; it never acknowledges an unrecorded rejection.

## Local development

With the development database, object storage and processing services configured:

```sh
NODE_ENV=development bun scripts/ingest-mail.ts \
  --file message.eml \
  --mail-from member@example.test \
  --rcpt-to TOKEN@inbound.example.test \
  --remote-ip 192.0.2.1 \
  --helo smtp.example.test \
  --inbound-domain inbound.example.test \
  --virus-verdict pass
```

Run from `apps/api`. Replace the example SMTP metadata with the actual delivery
metadata and supply the trusted scanner's verdict. Repeat `--rcpt-to` for multiple
recipients. The command verifies authentication locally; fixture headers cannot
bypass it. `--help` requires no database connection. Standard output contains only
structured outcomes; errors omit message contents and tokens.

Raw input is limited to 25 MiB, each attachment to 10 MiB, with at most 25
attachments and 100 envelope recipients. Shared correspondence limits own body
character and attachment counts; inbound limits additionally bound parsing memory,
MIME depth, headers, DNS queries and provider-read time.
