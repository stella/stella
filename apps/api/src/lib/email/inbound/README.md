# Inbound correspondence

`receiveInboundMail` takes RFC 822 bytes, the SMTP envelope, a receipt timestamp,
verifier and trusted virus verdict. It files into the existing correspondence
model. SMTP recipients, rather than message To/Cc headers, resolve the matter.
Addresses use 32 random bytes encoded as 64 lowercase hexadecimal characters.

## Trust and attribution

- The root `mailauth/nodemailer` resolution replaces mailauth 5.0.3's vulnerable
  address parser with Nodemailer 10.0.10, the same copy the API ships. Remove this
  resolution when mailauth itself pins a patched version.
- The local verifier evaluates SPF, DKIM and DMARC against DNS using the supplied
  SMTP peer, HELO and MAIL FROM. Received and Authentication-Results message
  headers cannot authorize a delivery. A passing DMARC result must also have an
  aligned passing SPF or DKIM identifier.
- Provider verdicts are out-of-band metadata. Authenticate the notification
  publisher before calling `receiveSesInboundMail`. Configure its allowed S3
  bucket and key prefix; the adapter verifies both before fetching bytes.
  Provider DMARC counts only when the notification's single `From` header has
  the same domain as the parsed author.
- A verified primary address or verified alias requires current matter access.
  An approved shared mailbox requires current organization or matter scope.
  Its filer is the mailbox; documents have no human creator. The approval's
  administrator is never substituted as the filer or document creator.
- Delivery authentication stays bound to the outer sender. `intake` distinguishes
  direct mail, inline forwards and attached originals; extracted headers are the
  forwarder's assertions. An attached original's DKIM signature is checked against
  its exact decoded bytes with bounded DNS access. A verified signature identifies
  its signing domain, not an authenticated original author. Unsigned, invalid or
  partially signed originals remain unverified. Unavailable DNS, an exhausted
  verification budget or headers exceeding the inbound header limit also leave
  this optional proof unverified.
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

## Queue transport

An SES receipt rule stores each message in S3 and publishes its notification
to SNS, which delivers to an SQS queue with a dead-letter redrive policy. The
scheduler job `inboundMail.receive.minutely` drains that queue; operator
pauses apply to it like any other job. It runs only when
`INBOUND_MAIL_QUEUE_URL`, `INBOUND_MAIL_TOPIC_ARN`, `INBOUND_MAIL_BUCKET` and
`INBOUND_MAIL_KEY_PREFIX` are all set with `INBOUND_MAIL_DOMAIN`; a partial
set fails boot. The queue is reached in the region its URL names (a URL
that is not an SQS queue URL fails boot); the bucket in `S3_REGION`.

The trust boundary is IAM: the queue policy must admit only the configured
topic, and the topic only the receipt rule. SNS signatures are not fetched.
Subscribe the queue without raw message delivery; the receiver reads the SNS
envelope and requires its `TopicArn` to equal the configured topic.

Each run leases bounded batches with a visibility timeout covering a batch and
files messages one at a time. A message is deleted after a terminal result:
filed, duplicate, dropped, or the provider's setup notification. A malformed
envelope, another topic or an unsupported notification type is logged as
poison and left; so is a retryable error. Both return when their visibility
timeout ends and reach the dead-letter queue after the redrive limit, where
they remain for operator repair. A failed or cancelled delete leaves a filed
message on the queue; its redelivery converges as a duplicate. Logs carry the
queue message id, receive count and outcome, never subjects, bodies, addresses
or tokens.

## Uploaded email files

An `.eml` or `.msg` file stored in a matter also becomes correspondence linked
to that file, so one item appears in both Files and Correspondence. The native
extraction run every new file version reaches hands the file to the
`uploaded-mail-correspondence` queue after its text projection, so every upload
transport is covered and extraction never fails on this step. Every file classification reaches this queue, including a version that is no
longer a message. The job is keyed by the file and runs in the API's workers: the document-processing worker
enqueues through `upload-enqueue.ts` alone, keeping the filing code and the API
environment out of its import graph. The job identifies its stored file
generation and reads the current entity version; filing and retirement check
that version again under a source lock, so stale jobs cannot replace current
correspondence. The job rereads the stored object; a
permanent refusal is a logged skip, an unavailable database retries with
backoff, and only an exhausted job or a failed hand-off is captured.

The public filing boundary reconciles every terminal skip through the system
generation-fenced retirement protocol, including access denial, parse refusals
and files that are no longer correspondence. Retirement preserves the record,
its source associations and user state. It uses the version captured before
the filing attempt, so a refusal cannot affect a newer version. Missing or initially stale sources leave current records
alone. A cleanup failure remains retryable; it cannot acknowledge a refusal.
Retryable filing errors also remain errors, preserving any record already
created while attachment completion retries.

- `parseEmailFile` reads the file as one message under the inbound limits: the
  same normalization as delivered mail, with an adapter for Outlook's MAPI
  properties. A forward inside the file is not extracted.
- Provenance is `source: "upload"` with the file's entity id. There is no
  transport authentication. An `.eml` file's own DKIM signature is checked like
  an attached original; an `.msg` file has none and stays unverified.
- The file's creator is the filer and must hold matter access when the run
  files it. A file without a creator, an inbound attachment of a delivered
  record, or an unreadable or oversized message files nothing; the skip is
  logged with its reason and the file is unaffected.
- Attachments stay inside the file and are not stored again; the record links
  the file. Uploaded files of both channels are registered in
  `correspondence_sources`; only explicitly deleting the last source document
  removes its record. The attachment policy is per
  source: a delivery stores each attachment, so a blocked type refuses it; an
  upload retains them in the already scanned file, so only count and size
  limits apply.
- Each file has at most one record, keyed by the file. A delivered message and
  an uploaded file of it remain separate records, as do two copies of an email
  file. A content-changing replacement updates the derived message columns in
  place, preserving the record identity, handling state, assignee and filer history.

When other source copies retain the previous message, a changed copy moves to
its new or existing matching record. The surviving copies keep their original
record and user state. A sole-source replacement refreshes its derived attachment
links without removing the underlying matter documents or their user-authored
metadata and annotations. Retirement, deduplication and source-link maintenance never delete
correspondence. A replacement that would collide with another record is refused
with a conflict, preserving both records and their independent user state.
Existing uploaded email records are found through their indexed source pointer;
no full-table backfill is needed.

## Uploaded data-box messages

A `.zfo` file, a Czech data-box (ISDS) message exported as a CMS SignedData
over the message XML, takes the same path and files a `data_box` record.

- `parseDataBoxMessage` (`src/lib/email/correspondence/data-box/zfo.ts`) reads the envelope and the
  base64 files without network access. The file is bounded by the document
  upload limit and its files by the correspondence attachment limit; a
  document type declaration is refused, so no entity is expanded or fetched.
  The system's seal is recorded as found (signer, issuer, serial number,
  signing time) and stays unverified; the `.zfo` file keeps its bytes.
- The record's addresses are box IDs and its subject is the annotation; the
  envelope (reference numbers and file marks of both parties, delivery and
  acceptance times, status, delivery flags) is `dataBox`.
- The organization's own boxes (`organization_settings.data_box_ids`, edited
  through `organization-settings/correspondence/data-boxes`) decide the
  direction: sent from one is outgoing, sent to one incoming; neither or both
  leaves it incoming with `directionBasis` `unknown`. Each add or remove
  re-derives the direction of filed records from their stored envelopes in
  the matters the administrator can reach, writing only rows whose basis
  changes, so a repeat converges.
- Each file of the message is scanned before anything is written, then stored
  as a document in the `.zfo` file's folder and linked as an attachment. A
  rejected file refuses the whole message; a replay resumes missing ordinals.
  Each attachment write rechecks the source version and record content hash
  inside the document transaction, so an older completion cannot claim ordinals
  after a source refresh.
- The message ID keys the record in the matter: another file of the same
  message, in a batch or later, adds its uploader as a filer and stores no
  second set of documents. `correspondence_sources` retains every source copy.
  Explicit deletion of the current `.zfo` source switches the record to a
  surviving copy; only deleting its last source document removes the record
  and attachment links. Reclassification preserves the record and its history. Each
  matter owns its record and sources independently. Any copy can resume missing
  attachment ordinals, including when the initial source was deleted.
- The detail read lists the organization's contacts whose data boxes include
  the sender or recipient box ID. Matching only reads contacts.

## Local development

With the development database, object storage and processing services configured:

```sh
NODE_ENV=development STELLA_LOCAL_DEV=1 bun scripts/ingest-mail.ts \
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
