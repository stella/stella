import aresManifest from "@stll/catalogue/entries/native-tools/ares/manifest.json";
import contractReviewManifest from "@stll/catalogue/entries/skills/contract-review-anthropic/manifest.json";
import jurisRankManifest from "@stll/catalogue/entries/skills/jurisrank/manifest.json";
import { parseCatalogueEntry } from "@stll/catalogue/schema";

// The catalogue page and its pending view both render these cards, and the
// pending view renders before the catalogue chunk loads. So the three entries
// come from their own manifests, through the parse the catalogue applies,
// rather than from the whole loaded catalogue.
export const contractReview = parseCatalogueEntry(contractReviewManifest);
export const jurisRank = parseCatalogueEntry(jurisRankManifest);
export const ares = parseCatalogueEntry(aresManifest);
