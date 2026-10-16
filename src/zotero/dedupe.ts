import {
  EXTRA_CORPUS_ID,
  EXTRA_S2_ID,
  PaperIds,
  extraLines,
  normalizeArxiv,
  normalizeDOI,
  normalizeTitle,
} from "./identifiers";

async function searchField(
  libraryID: number,
  field: string,
  value: string,
): Promise<Zotero.Item[]> {
  const s = new Zotero.Search({ libraryID });
  s.addCondition(field as any, "contains" as any, value);
  const ids = await s.search();
  return (Zotero.Items.get(ids) as Zotero.Item[]).filter(
    (item) => item.isRegularItem() && !item.deleted,
  );
}

export function itemDOI(item: Zotero.Item): string | undefined {
  const raw =
    (fieldOrEmpty(item, "DOI") ||
      extraLines(item.getField("extra") as string).get("doi")) ??
    "";
  return raw ? normalizeDOI(raw) : undefined;
}

export function itemArxiv(item: Zotero.Item): string | undefined {
  const archiveID = fieldOrEmpty(item, "archiveID");
  if (/^arxiv:/i.test(archiveID)) return normalizeArxiv(archiveID);
  const fromExtra = extraLines(item.getField("extra") as string).get("arxiv");
  if (fromExtra) return normalizeArxiv(fromExtra);
  const url = fieldOrEmpty(item, "url");
  const m = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i.exec(
    url,
  );
  return m ? normalizeArxiv(m[1]) : undefined;
}

export function itemS2Id(item: Zotero.Item): string | undefined {
  return extraLines(item.getField("extra") as string)
    .get(EXTRA_S2_ID.toLowerCase())
    ?.toLowerCase();
}

export function itemCorpusId(item: Zotero.Item): string | undefined {
  return extraLines(item.getField("extra") as string).get(
    EXTRA_CORPUS_ID.toLowerCase(),
  );
}

export function itemYear(item: Zotero.Item): number | undefined {
  const year = parseInt(
    Zotero.Date.multipartToSQL(
      item.getField("date", true, true) as string,
    ).slice(0, 4),
  );
  return year > 0 ? year : undefined;
}

export function fieldOrEmpty(item: Zotero.Item, field: string): string {
  const fieldID = Zotero.ItemFields.getID(field);
  if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
    return "";
  }
  return (item.getField(field) as string) || "";
}

/**
 * Finds an existing regular item matching any identifier, checked strongest
 * first: DOI, arXiv id, S2 paper id, CorpusId, then normalized title + year.
 */
export async function findExisting(
  libraryID: number,
  ids: PaperIds,
): Promise<Zotero.Item | null> {
  if (ids.doi) {
    const doi = normalizeDOI(ids.doi);
    for (const field of ["DOI", "extra"]) {
      const hit = (await searchField(libraryID, field, doi)).find(
        (item) => itemDOI(item) === doi,
      );
      if (hit) return hit;
    }
  }
  if (ids.arxiv) {
    const arxiv = normalizeArxiv(ids.arxiv);
    for (const field of ["archiveID", "extra", "url"]) {
      const hit = (await searchField(libraryID, field, arxiv)).find(
        (item) => itemArxiv(item) === arxiv,
      );
      if (hit) return hit;
    }
  }
  if (ids.s2Id) {
    const s2Id = ids.s2Id.toLowerCase();
    const hit = (await searchField(libraryID, "extra", s2Id)).find(
      (item) => itemS2Id(item) === s2Id,
    );
    if (hit) return hit;
  }
  if (ids.corpusId) {
    const hit = (await searchField(libraryID, "extra", ids.corpusId)).find(
      (item) => itemCorpusId(item) === ids.corpusId,
    );
    if (hit) return hit;
  }
  if (ids.title) {
    const wanted = normalizeTitle(ids.title);
    // The longest word narrows the SQL search; the exact check happens below
    const probe = wanted.split(" ").sort((a, b) => b.length - a.length)[0];
    if (probe && probe.length >= 4 && wanted.length >= 12) {
      const hit = (await searchField(libraryID, "title", probe)).find(
        (item) =>
          normalizeTitle(item.getField("title") as string) === wanted &&
          (!ids.year || !itemYear(item) || itemYear(item) === ids.year),
      );
      if (hit) return hit;
    }
  }
  return null;
}

export function hasPDF(item: Zotero.Item): boolean {
  return item
    .getAttachments()
    .some((id) => (Zotero.Items.get(id) as Zotero.Item).isPDFAttachment());
}

export function describeItem(item: Zotero.Item) {
  const creators = item.getCreators();
  return {
    key: item.key,
    libraryID: item.libraryID,
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    title: item.getField("title") as string,
    year: itemYear(item),
    authors: creators
      .slice(0, 8)
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
    doi: itemDOI(item),
    arxiv: itemArxiv(item),
    s2PaperId: itemS2Id(item),
    hasPDF: hasPDF(item),
    collections: item.getCollections().map((id) => {
      const c = Zotero.Collections.get(id) as Zotero.Collection | false;
      return c ? c.key : String(id);
    }),
  };
}
