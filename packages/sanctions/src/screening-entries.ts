import {
  NumberColumn,
  ObjectColumn,
  PostingColumn,
  StringMap,
} from "./compact-storage";
import type { AliasQuality, SanctionsEntry } from "./entry";

export type ScreeningEntry = Pick<
  SanctionsEntry,
  | "source"
  | "sourceId"
  | "entityType"
  | "birthDates"
  | "nationalities"
  | "identifiers"
>;

/** Screening fields stay directly accessible; response-only fields live in columns. */
export class ScreeningEntries {
  readonly entries = new ObjectColumn<ScreeningEntry>();

  private readonly issuers = new ObjectColumn<SanctionsEntry["issuer"]>();
  private readonly referenceNumbers = new ObjectColumn<string | null>();
  private readonly nameOffsets = new NumberColumn();
  private readonly names = new ObjectColumn<string>();
  private readonly nameQualities = new ObjectColumn<AliasQuality>();
  private readonly addresses = new ObjectColumn<SanctionsEntry["addresses"]>();
  private readonly programmes = new ObjectColumn<string | null>();
  private readonly legalBases = new ObjectColumn<string | null>();
  private readonly listedOn = new ObjectColumn<string | null>();
  private readonly sourceUrls = new ObjectColumn<string>();

  push(entry: SanctionsEntry): number {
    const index = this.entries.push({
      source: entry.source,
      sourceId: entry.sourceId,
      entityType: entry.entityType,
      birthDates: entry.birthDates,
      nationalities: entry.nationalities,
      identifiers: entry.identifiers,
    });
    this.issuers.push(entry.issuer);
    this.referenceNumbers.push(entry.referenceNumber);
    this.nameOffsets.push(this.names.length);
    for (const name of entry.names) {
      this.names.push(name.name);
      this.nameQualities.push(name.quality);
    }
    this.addresses.push(entry.addresses);
    this.programmes.push(entry.programme);
    this.legalBases.push(entry.legalBasis);
    this.listedOn.push(entry.listedOn);
    this.sourceUrls.push(entry.sourceUrl);
    return index;
  }

  hydrate(index: number): SanctionsEntry {
    const entry = this.entries.get(index);
    const nameStart = this.nameOffsets.get(index);
    const nameEnd =
      index + 1 < this.entries.length
        ? this.nameOffsets.get(index + 1)
        : this.names.length;
    const names = [];
    for (let nameIndex = nameStart; nameIndex < nameEnd; nameIndex += 1) {
      names.push({
        name: this.names.get(nameIndex),
        quality: this.nameQualities.get(nameIndex),
      });
    }
    return {
      source: entry.source,
      issuer: this.issuers.get(index),
      sourceId: entry.sourceId,
      referenceNumber: this.referenceNumbers.get(index),
      entityType: entry.entityType,
      names,
      birthDates: entry.birthDates,
      nationalities: entry.nationalities,
      identifiers: entry.identifiers,
      addresses: this.addresses.get(index),
      programme: this.programmes.get(index),
      legalBasis: this.legalBases.get(index),
      listedOn: this.listedOn.get(index),
      sourceUrl: this.sourceUrls.get(index),
    };
  }
}

/** Identifier keys map to bounded append-only postings, without one large Map. */
export class IdentifierPostings {
  private readonly ids = new StringMap<number>();
  private readonly postings = new PostingColumn();

  add(key: string, entry: number): void {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.postings.addList();
      this.ids.set(key, id);
    }
    this.postings.push(id, entry);
  }

  get(key: string): Iterable<number> | undefined {
    const id = this.ids.get(key);
    return id === undefined ? undefined : this.postings.get(id);
  }
}
