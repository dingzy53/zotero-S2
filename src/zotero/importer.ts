import { RateLimiter } from "../s2/rateLimiter";
import { S2Paper } from "../s2/types";
import { MappedItem, mergeExtra, s2ToZotero } from "./s2ToZotero";

export type MetadataSource = "s2" | "translator";

/** arXiv's API asks for ≤1 request per 3 s; Crossref shares the queue. */
const translatorLimiter = new RateLimiter(3000);

function isValidField(itemTypeID: number, field: string): boolean {
  const fieldID = Zotero.ItemFields.getID(field);
  return !!fieldID && Zotero.ItemFields.isValidForType(fieldID, itemTypeID);
}

/** Writes mapped fields; with `onlyEmpty`, existing values are kept. Returns changed field names. */
export function applyMapped(
  item: Zotero.Item,
  mapped: MappedItem,
  onlyEmpty: boolean,
): string[] {
  const changed: string[] = [];
  for (const [field, value] of Object.entries(mapped.fields)) {
    if (!isValidField(item.itemTypeID, field)) continue;
    const current = item.getField(field) as string;
    if (onlyEmpty && current) continue;
    if (current === value) continue;
    item.setField(field, value);
    changed.push(field);
  }
  if (mapped.creators.length && (!onlyEmpty || !item.numCreators())) {
    item.setCreators(mapped.creators);
    changed.push("creators");
  }
  const extra = item.getField("extra") as string;
  const merged = mergeExtra(extra, mapped.extra);
  if (merged !== extra) {
    item.setField("extra", merged);
    changed.push("extra");
  }
  return changed;
}

async function createFromS2(
  libraryID: number,
  paper: S2Paper,
  collectionID: number | null,
): Promise<Zotero.Item> {
  const mapped = s2ToZotero(paper);
  // Provenance, as Zotero's translators record it ("arXiv.org", "DOI.org (Crossref)")
  mapped.fields.libraryCatalog = "Semantic Scholar";
  const item = new Zotero.Item(mapped.itemType as any);
  item.libraryID = libraryID;
  if (!isValidField(item.itemTypeID, "DOI") && mapped.fields.DOI) {
    mapped.extra.unshift(`DOI: ${mapped.fields.DOI}`);
  }
  applyMapped(item, mapped, false);
  if (collectionID) item.setCollections([collectionID]);
  await item.saveTx();
  return item;
}

async function createFromTranslator(
  libraryID: number,
  paper: S2Paper,
  collectionID: number | null,
): Promise<Zotero.Item | null> {
  const doi = paper.externalIds?.DOI;
  const arxiv = paper.externalIds?.ArXiv;
  const identifier = doi ? { DOI: doi } : arxiv ? { arXiv: arxiv } : null;
  if (!identifier) return null;

  return translatorLimiter.schedule(async () => {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier(identifier);
    const translators = await translate.getTranslators();
    if (!translators.length) return null;
    translate.setTranslator(translators);
    const items: Zotero.Item[] = await translate.translate({
      libraryID,
      collections: collectionID ? [collectionID] : false,
      // pdf.ts attaches files, so nothing is attached twice
      saveAttachments: false,
    } as any);
    const item = items[0];
    if (!item) return null;
    // The item is saved. If tagging it fails, still return it: throwing
    // would make createItem() fall back to S2 and create a second copy
    try {
      // Tag our provenance so later dedupe is exact
      const extra = item.getField("extra") as string;
      const merged = mergeExtra(extra, s2ToZotero(paper).extra);
      if (merged !== extra) {
        item.setField("extra", merged);
        await item.saveTx();
      }
    } catch (e) {
      Zotero.logError(e as Error);
    }
    return item;
  });
}

export async function createItem(
  libraryID: number,
  paper: S2Paper,
  collectionID: number | null,
  source: MetadataSource,
): Promise<{ item: Zotero.Item; source: MetadataSource }> {
  if (source === "translator") {
    try {
      const item = await createFromTranslator(libraryID, paper, collectionID);
      if (item) return { item, source: "translator" };
    } catch (e) {
      Zotero.debug(
        `[Zotero S2] translator lookup failed, using S2 metadata: ${e}`,
      );
    }
  }
  return {
    item: await createFromS2(libraryID, paper, collectionID),
    source: "s2",
  };
}

export async function addTagsAndNote(
  item: Zotero.Item,
  tags: string[] | undefined,
  note: string | undefined,
): Promise<void> {
  if (tags?.length) {
    for (const tag of tags) item.addTag(tag);
    await item.saveTx();
  }
  if (note) {
    const html = note.startsWith("<") ? note : `<p>${escapeHTML(note)}</p>`;
    // Keep repeated calls idempotent: don't add the same note twice
    const exists = item
      .getNotes()
      .some((id) => (Zotero.Items.get(id) as Zotero.Item).getNote() === html);
    if (!exists) {
      const noteItem = new Zotero.Item("note");
      noteItem.libraryID = item.libraryID;
      noteItem.parentID = item.id;
      noteItem.setNote(html);
      await noteItem.saveTx();
    }
  }
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}
