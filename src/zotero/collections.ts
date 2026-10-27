import { ToolError } from "../mcp/errors";
import { libraryWrites } from "./writeLock";

const KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

export function resolveLibraryID(
  libraryID?: number,
  needsEdit = false,
): number {
  const id = libraryID ?? Zotero.Libraries.userLibraryID;
  const library = Zotero.Libraries.get(id);
  if (!library) throw new ToolError(`Library ${id} not found`);
  if (needsEdit && !library.editable) {
    throw new ToolError(`Library ${id} (${library.name}) is read-only`);
  }
  return id;
}

export function collectionPath(collection: Zotero.Collection): string {
  const parts = [collection.name];
  let parentID = collection.parentID;
  while (parentID) {
    const parent = Zotero.Collections.get(parentID) as
      Zotero.Collection | false;
    if (!parent) break;
    parts.unshift(parent.name);
    parentID = parent.parentID;
  }
  return parts.join("/");
}

function childrenOf(libraryID: number, parent: Zotero.Collection | null) {
  return parent
    ? Zotero.Collections.getByParent(parent.id)
    : Zotero.Collections.getByLibrary(libraryID);
}

function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Finds a collection by key, or by a slash path like "Agent/Reading". */
export function findCollection(
  libraryID: number,
  ref: string,
): Zotero.Collection | null {
  const trimmed = ref.trim();
  if (KEY_RE.test(trimmed)) {
    const byKey = Zotero.Collections.getByLibraryAndKey(libraryID, trimmed);
    if (byKey) return byKey as Zotero.Collection;
  }
  let current: Zotero.Collection | null = null;
  for (const name of splitPath(trimmed)) {
    const siblings = childrenOf(libraryID, current);
    const next: Zotero.Collection | undefined =
      siblings.find((c) => c.name === name) ??
      siblings.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!next) return null;
    current = next;
  }
  return current;
}

/** Resolves (and with `create`, builds) every segment of a collection path. */
export function resolveCollection(
  libraryID: number,
  ref: string,
  create: boolean,
): Promise<{ collection: Zotero.Collection; created: boolean }> {
  return libraryWrites.run(() => resolveUnlocked(libraryID, ref, create));
}

async function resolveUnlocked(
  libraryID: number,
  ref: string,
  create: boolean,
): Promise<{ collection: Zotero.Collection; created: boolean }> {
  const found = findCollection(libraryID, ref);
  if (found) return { collection: found, created: false };
  if (!create) throw new ToolError(`Collection "${ref}" not found`);

  const names = splitPath(ref);
  if (!names.length) throw new ToolError("Collection path is empty");
  let current = null as Zotero.Collection | null;
  let created = false;
  for (const name of names) {
    const siblings = childrenOf(libraryID, current);
    let next: Zotero.Collection | undefined =
      siblings.find((c) => c.name === name) ??
      siblings.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!next) {
      next = new Zotero.Collection({
        libraryID,
        name,
        parentID: current?.id,
      } as any);
      await next.saveTx();
      created = true;
    }
    current = next;
  }
  return { collection: current!, created };
}

export function describeCollection(c: Zotero.Collection) {
  const parent = c.parentID
    ? (Zotero.Collections.get(c.parentID) as Zotero.Collection | false)
    : false;
  return {
    key: c.key,
    name: c.name,
    path: collectionPath(c),
    parentKey: parent ? parent.key : null,
    itemCount: c.getChildItems(true).length,
  };
}

export function listCollections(libraryID: number) {
  return Zotero.Collections.getByLibrary(libraryID, true)
    .map(describeCollection)
    .sort((a, b) => a.path.localeCompare(b.path));
}
