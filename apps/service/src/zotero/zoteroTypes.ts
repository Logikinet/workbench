/**
 * Zotero Local Connector types (Task 49).
 * Read-only local API — never open zotero.sqlite.
 */

export interface ZoteroStatus {
  running: boolean;
  baseUrl: string;
  libraryId: string;
  detail: string;
  checkedAt: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection?: string;
  version?: number;
}

export interface ZoteroCreator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItem {
  key: string;
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  date?: string;
  year?: number;
  publicationTitle?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  tags: string[];
  collections: string[];
  parentItem?: string;
  missingMetadata: string[];
  raw: Record<string, unknown>;
}

export interface ZoteroFullText {
  itemKey: string;
  content: string;
  contentType?: string;
  indexedPages?: number;
  indexedChars?: number;
  available: boolean;
  detail?: string;
}

export interface ZoteroQuery {
  q?: string;
  collectionKey?: string;
  itemType?: string;
  tag?: string;
  limit?: number;
  start?: number;
  /** When true, only items that include a DOI. */
  requireDoi?: boolean;
  yearFrom?: number;
  yearTo?: number;
}

export interface ZoteroEvidenceSeed {
  itemKey: string;
  title: string;
  source: string;
  author?: string;
  publishedAt?: string;
  excerpt: string;
  doi?: string;
  origin: "zotero";
  location?: { page?: number; anchor?: string };
}

export const DEFAULT_ZOTERO_LOCAL_BASE = "http://127.0.0.1:23119/api";
export const DEFAULT_ZOTERO_LIBRARY = "users/0";
