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
  importFromURL(options: {
    libraryID: number;
    url: string;
    contentType?: string;
    collections?: number[];
    parentItemID?: number;
    title?: string;
  }): Promise<Zotero.Item>;
}

interface RecognizeDocumentAPI {
  canRecognize(item: Zotero.Item): boolean;
  recognizeItems(items: Zotero.Item[]): Promise<void>;
}

export const Attachments = (): AttachmentsAPI =>
  Zotero.Attachments as unknown as AttachmentsAPI;

export const RecognizeDocument = (): RecognizeDocumentAPI =>
  (Zotero as any).RecognizeDocument as RecognizeDocumentAPI;
