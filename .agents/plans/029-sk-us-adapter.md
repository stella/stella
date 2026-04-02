# Plan: Slovak Constitutional Court (Ústavný súd) Adapter

Date: 2026-04-02

## Goal

Build an adapter for the Slovak Constitutional Court (Ústavný
súd SR, ustavnysud.sk) covering ~52,000 decisions from 1993
to present. The court has a separate system from obcan.justice.sk
(which covers all other Slovak courts).

## API Discovery

The court's website is a Liferay DXP portal with a custom
React search module (`dtln-search-rozhodnutia`). The actual
REST API was discovered by intercepting XHR calls via Chrome
DevTools:

- **Search**: `POST https://www.ustavnysud.sk/o/v1/dms/search`
- **Codelists**: `GET https://www.ustavnysud.sk/o/v1/codelist/decision`
- **PDF download**: `GET https://www.ustavnysud.sk/docDownload/{documentId}` (no auth)
- **OAuth2 token**: `POST https://www.ustavnysud.sk/o/oauth2/token`

## Authentication

The search API requires an OAuth2 bearer token obtained via
`client_credentials` grant. The client_id and client_secret are
embedded in the site's JavaScript bundle — they're public
credentials intended for anonymous browser access, not private
API keys.

**What this means for our adapter:**
- We need to call `/o/oauth2/token` with client_id +
  client_secret before each search session
- Tokens expire (likely 600s based on typical Liferay config);
  the adapter should cache and refresh them
- The credentials are NOT secret — they're shipped to every
  browser that visits the page. We can commit them to the
  adapter source code (same as the NALUS base URL or the
  obcan.justice.sk API URL — they're public endpoints)
- If the court rotates credentials, the adapter breaks and
  we update the values. This is the same risk as any URL change.
- The PDF download endpoint (`/docDownload/{uuid}`) requires
  NO authentication — PDFs are fully public

**Alternative: scrape without API.** The search results are
rendered in the DOM. We could scrape the HTML directly without
auth, but this is fragile (DOM structure changes) and misses
metadata that the API provides. The API is the right approach.

## Design Decisions

- **Offset-based pagination.** The API uses `start` (offset) +
  `pageSize`, not cursor-based. We use `createPagePaginatedFetch`
  with `zeroIndexed: true` and convert page numbers to offsets.
  Or implement custom fetchPage with offset tracking.

- **Reuse SK courts parser.** The PDF format is identical to
  regular Slovak courts (same `@libpdf/core` extraction, same
  section markers: rozhodol, odôvodnenie, poučenie). The
  existing `parseSkDecisionPdf` should work as-is.

- **Rich metadata from API, not PDF.** Unlike obcan.justice.sk
  where metadata comes from a separate detail endpoint, the SK
  ÚS search API returns all fields inline. No detail fetch
  needed — one API call gives both the list and full metadata.

## Scope

**In scope:**

- `adapters/sk-us.ts` — adapter with OAuth2 token management
- Register in `adapters/index.ts`, `consts.ts`
- Add to `ingest-case-law.ts` (initially disabled)
- Reuse `parsers/sk-courts.ts` for PDF → AST

**Out of scope:**

- Decisions from 1993-2004 (separate "digitalized" section,
  likely scanned PDFs without text layer)
- Zbierka nálezov (collection of rulings, separate section)
- Full-text content field from the API (`content` is null in
  search results; fulltext comes from the PDF)

## API Response Shape

```typescript
type SearchResponse = {
  documents: Document[];
  numFound: number;
  facetCount: Record<string, Record<string, number>>;
};

type Document = {
  docType: "USSR_DECISION";
  documentId: string; // UUID for PDF download
  title: string;
  mkRSAPNumberOfFile: string; // case number
  mkECLI: string;
  mkDateOfDecision: string; // "MM/DD/YYYY HH:mm:ss"
  mkFormOfDecision: string; // Nález, Uznesenie
  mkTypeOfDecision: string[];
  mkJudgeReporter: string;
  mkCause: string[];
  mkTypeOfProceeding: string;
  mkResultOfNegotiation: string[];
  mkDecisionInTermsOf: string[];
  mkDateOfLegalForce: string;
  mkComplainedLegalRegulation: string;
  mkWordRegister: string[];
  mkMaterialRegister: string[];
  mkDifferentView: string[];
  // ... many more mk* fields
};
```

## Search Request Shape

```typescript
type SearchRequest = {
  docType: "USSR_DECISION_MK";
  start: number; // offset (0, 10, 20...)
  pageSize: number;
  searchFilter: {
    filterNameValue: Array<{
      type: "DATE_RANGE";
      fieldName: string;
      fieldValue: { FROM: string | null; TO: string };
    }>;
  };
  facetFilter: { facetFilterNameValue: [] };
  facets: string[];
  fieldsToReturn: string[];
};
```

## Implementation

### Token management

```typescript
let cachedToken: { value: string; expiresAt: number } | null;

const getToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
  });
  const { access_token, expires_in } = await resp.json();
  cachedToken = {
    value: access_token,
    expiresAt: Date.now() + (expires_in - 30) * 1000,
  };
  return access_token;
};
```

### Adapter key fields mapping

| API field | IngestionResult field |
|-----------|----------------------|
| `mkRSAPNumberOfFile` | `caseNumber` |
| `mkECLI` | `ecli` |
| `"Ústavný súd SR"` | `court` (constant) |
| `mkDateOfDecision` | `decisionDate` |
| `mkFormOfDecision` | `decisionType` |
| `documentId` → `/docDownload/{id}` | `documentUrl` |
| `mkJudgeReporter` | `metadata.judge` |
| `mkCause` | `metadata.cause` |
| `mkTypeOfProceeding` | `metadata.proceedingType` |
| `mkResultOfNegotiation` | `metadata.result` |
| `mkDecisionInTermsOf` | `metadata.legalBasis` |
| `mkComplainedLegalRegulation` | `metadata.challengedLegislation` |
| `mkWordRegister` | `metadata.wordRegister` |
| `mkDifferentView` | `metadata.dissentingOpinion` |

## Test Cases

- OAuth2 token acquisition and caching
- Search pagination (offset 0, 10, 20...)
- Date format parsing ("MM/DD/YYYY HH:mm:ss" → ISO)
- PDF download and parsing via existing SK parser
- Empty search results handling
- Token expiry and refresh

## Open Questions

- What are the exact client_id and client_secret values?
  (Blocked by Chrome tool output filtering; need to extract
  from JS bundle manually or via a different approach)
- Are pre-2004 digitalized decisions in the same API or a
  separate system?
- Does the API support sorting? (The search body didn't
  include an explicit sort field; results seem sorted by
  date desc)
