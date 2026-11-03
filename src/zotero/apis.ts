/**
 * Zotero 10 APIs missing from (or mistyped in) zotero-types.
 * Signatures follow chrome/content/zotero/xpcom/attachments.js and recognizeDocument.js.
 */

export interface UrlResolver {
  url?: string;
  pageURL?: string;
  accessMethod?: string;
}

interface AttachmentsAPI {
  getFileResolvers(item: Zotero.Item, methods?: string[]): UrlResolver[];
  addFileFromURLs(
    item: Zotero.Item,
    resolvers: Array<UrlResolver | string | (() => Promise<UrlResolver[]>)>,
  ): Promise<Zotero.Item | false>;
  /** Copies (or with moveFile, moves) a local file into storage. Doesn't sniff content. */
  importFromFile(options: {
    file: string;
    libraryID?: number;
    parentItemID?: number;
    collections?: number[];
    title?: string;
    fileBaseName?: string;
    contentType?: string;
    moveFile?: boolean;
  }): Promise<Zotero.Item>;
  /**
   * Saves the first resolver that yields a file to `path`. A `pageURL` that
   * returns HTML is searched for its PDF link. Returns false if none worked.
   */
  downloadFirstAvailableFile(
    resolvers: UrlResolver[],
    path: string,
    options: { enforceFileType?: boolean },
  ): Promise<{ url: string; props: UrlResolver } | false>;
  getFileBaseNameFromItem(
    item: Zotero.Item,
    options?: { attachmentTitle?: string },
  ): string;
}

interface UtilitiesInternalAPI {
  /** utilities_internal.js; false for a missing file. */
  md5Async(path: string): Promise<string | false>;
}

interface RecognizeDocumentAPI {
  canRecognize(item: Zotero.Item): boolean;
  recognizeItems(items: Zotero.Item[]): Promise<void>;
}

export const Attachments = (): AttachmentsAPI =>
  Zotero.Attachments as unknown as AttachmentsAPI;

export const UtilitiesInternal = (): UtilitiesInternalAPI =>
  (Zotero.Utilities as any).Internal as UtilitiesInternalAPI;

export const RecognizeDocument = (): RecognizeDocumentAPI =>
  (Zotero as any).RecognizeDocument as RecognizeDocumentAPI;

/** chrome/content/zotero/modules/filePicker.mjs (Zotero 8+ needs a BrowsingContext). */
export interface FilePicker {
  init(parent: Window, title: string, mode: number): void;
  appendFilter(title: string, filter: string): void;
  appendFilters(mask: number): void;
  show(): Promise<number>;
  defaultString: string;
  defaultExtension: string;
  file: string;
  readonly modeSave: number;
  readonly returnOK: number;
  readonly returnReplace: number;
  readonly filterAll: number;
}

export function newFilePicker(): FilePicker {
  const { FilePicker } = ChromeUtils.importESModule(
    "chrome://zotero/content/modules/filePicker.mjs",
  ) as { FilePicker: new () => FilePicker };
  return new FilePicker();
}
