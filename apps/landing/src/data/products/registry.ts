import { caseLaw } from "./case-law";
import { tabularReview } from "./tabular-review";
import type { Product } from "./types";

// Add a product page by importing its data file and listing it here. The
// [slug].astro route, the Product nav menu, and the llms-full.txt feed all
// read from this registry.
export const products: readonly Product[] = [tabularReview, caseLaw];
