import * as v from "valibot";

// Passive regression fixture for
// `require-contract-domains/require-contract-domains`. The rule treats this
// file as a web source.
import type { InvoiceStatus } from "@stll/api-contract";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract";

// A copied domain or a literal limit restates what the contract owns.
// oxlint-disable-next-line require-contract-domains/require-contract-domains -- fixture: copied domain
const statuses = ["draft", "sent"] as const;
// oxlint-disable-next-line require-contract-domains/require-contract-domains -- fixture: literal schema limit
const schema = v.pipe(v.string(), v.maxLength(200));
// oxlint-disable-next-line require-contract-domains/require-contract-domains -- fixture: literal input limit
const field = <input maxLength={200} />;

// Contract-typed domains and contract limits stay valid.
// expect-clean: require-contract-domains/require-contract-domains
const typed = ["draft", "sent"] as const satisfies readonly InvoiceStatus[];
// expect-clean: require-contract-domains/require-contract-domains
const search = <input maxLength={SEARCH_QUERY_MAX_LENGTH} />;

export const contractDomainsFixture = [statuses, schema, field, typed, search];
