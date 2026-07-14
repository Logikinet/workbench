/**
 * Zotero Local Connector (Task 49).
 * Uses localhost API only — never opens zotero.sqlite.
 */

import {
  DEFAULT_ZOTERO_LIBRARY,
  DEFAULT_ZOTERO_LOCAL_BASE,
  type ZoteroCollection,
  type ZoteroCreator,
  type ZoteroEvidenceSeed,
  type ZoteroFullText,
  type ZoteroItem,
  type ZoteroQuery,
  type ZoteroStatus
} from "./zoteroTypes.js";

export interface ZoteroConnectorOptions {
  baseUrl?: string;
  libraryPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class ZoteroConnector {
  private readonly baseUrl: string;
  private readonly libraryPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: ZoteroConnectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ZOTERO_LOCAL_BASE).replace(/\/+$/, "");
    this.libraryPath = options.libraryPath ?? DEFAULT_ZOTERO_LIBRARY;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<ZoteroStatus> {
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.fetchImpl(this.url("/collections?limit=1"), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3_000)
      });
      if (!response.ok) {
        return {
          running: false,
          baseUrl: this.baseUrl,
          libraryId: this.libraryPath,
          detail: `Zotero local API returned HTTP ${response.status}.`,
          checkedAt
        };
      }
      return {
        running: true,
        baseUrl: this.baseUrl,
        libraryId: this.libraryPath,
        detail: "Zotero local API is reachable.",
        checkedAt
      };
    } catch (error) {
      return {
        running: false,
        baseUrl: this.baseUrl,
        libraryId: this.libraryPath,
        detail:
          error instanceof Error
            ? `Zotero local API unavailable: ${error.message}`
            : "Zotero local API unavailable.",
        checkedAt
      };
    }
  }

  async listCollections(): Promise<ZoteroCollection[]> {
    await this.requireRunning();
    const data = await this.getJson<unknown[]>(`/collections?limit=100`);
    return (Array.isArray(data) ? data : []).map(normalizeCollection).filter(Boolean) as ZoteroCollection[];
  }

  async searchItems(query: ZoteroQuery = {}): Promise<ZoteroItem[]> {
    await this.requireRunning();
    const params = new URLSearchParams();
    params.set("limit", String(query.limit ?? 25));
    if (query.start != null) params.set("start", String(query.start));
    if (query.q?.trim()) params.set("q", query.q.trim());
    if (query.itemType) params.set("itemType", query.itemType);
    if (query.tag) params.set("tag", query.tag);

    const path = query.collectionKey
      ? `/collections/${encodeURIComponent(query.collectionKey)}/items/top?${params}`
      : `/items?${params}`;

    const data = await this.getJson<unknown[]>(path);
    let items = (Array.isArray(data) ? data : []).map(normalizeItem).filter(Boolean) as ZoteroItem[];

    if (query.requireDoi) {
      items = items.filter((item) => Boolean(item.DOI?.trim()));
    }
    if (query.yearFrom != null) {
      items = items.filter((item) => (item.year ?? 0) >= query.yearFrom!);
    }
    if (query.yearTo != null) {
      items = items.filter((item) => (item.year ?? 9999) <= query.yearTo!);
    }
    return items;
  }

  async getItem(itemKey: string): Promise<ZoteroItem> {
    await this.requireRunning();
    const key = requireKey(itemKey);
    const data = await this.getJson<unknown>(`/items/${encodeURIComponent(key)}`);
    const item = normalizeItem(data);
    if (!item) throw new Error(`Zotero item “${key}” was not found or could not be parsed.`);
    return item;
  }

  async getChildren(itemKey: string): Promise<ZoteroItem[]> {
    await this.requireRunning();
    const key = requireKey(itemKey);
    const data = await this.getJson<unknown[]>(`/items/${encodeURIComponent(key)}/children`);
    return (Array.isArray(data) ? data : []).map(normalizeItem).filter(Boolean) as ZoteroItem[];
  }

  async getFullText(attachmentKey: string): Promise<ZoteroFullText | null> {
    await this.requireRunning();
    const key = requireKey(attachmentKey);
    try {
      const data = await this.getJson<Record<string, unknown>>(
        `/items/${encodeURIComponent(key)}/fulltext`
      );
      const content = typeof data.content === "string" ? data.content : "";
      if (!content.trim()) {
        return {
          itemKey: key,
          content: "",
          available: false,
          detail: "Full text is not indexed for this attachment."
        };
      }
      return {
        itemKey: key,
        content,
        contentType: typeof data.contentType === "string" ? data.contentType : undefined,
        indexedPages: typeof data.indexedPages === "number" ? data.indexedPages : undefined,
        indexedChars: typeof data.indexedChars === "number" ? data.indexedChars : undefined,
        available: true
      };
    } catch {
      return {
        itemKey: key,
        content: "",
        available: false,
        detail: "Full text endpoint returned an error."
      };
    }
  }

  async toEvidenceSeed(itemKey: string): Promise<ZoteroEvidenceSeed> {
    const item = await this.getItem(itemKey);
    const author = formatAuthors(item.creators);
    const excerpt =
      item.abstractNote?.trim() ||
      `${item.title}${item.publicationTitle ? ` — ${item.publicationTitle}` : ""}`.trim();
    return {
      itemKey: item.key,
      title: item.title,
      source: item.url || item.DOI || `zotero://${item.key}`,
      author,
      publishedAt: item.date,
      excerpt,
      doi: item.DOI,
      origin: "zotero"
    };
  }

  private async requireRunning(): Promise<void> {
    const status = await this.probe();
    if (!status.running) {
      throw new Error(`Zotero is not running or local API is unavailable: ${status.detail}`);
    }
  }

  private url(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}/${this.libraryPath}${normalized}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      headers: { Accept: "application/json" }
    });
    if (response.status === 404) {
      throw new Error(`Zotero resource not found: ${path}`);
    }
    if (!response.ok) {
      throw new Error(`Zotero local API HTTP ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }
}

function requireKey(key: string): string {
  const trimmed = key?.trim() ?? "";
  if (!trimmed) throw new Error("Zotero item key is required.");
  if (/[\\/]|\.sqlite/i.test(trimmed)) {
    throw new Error("Invalid Zotero key; SQLite paths are not allowed.");
  }
  return trimmed;
}

function normalizeCollection(raw: unknown): ZoteroCollection | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const data = asRecord(record.data) ?? record;
  const key = String(record.key ?? data.key ?? "").trim();
  const name = String(data.name ?? record.name ?? "").trim();
  if (!key || !name) return undefined;
  const parent = data.parentCollection;
  return {
    key,
    name,
    parentCollection:
      typeof parent === "string" && parent && parent !== "false" ? parent : undefined,
    version: typeof record.version === "number" ? record.version : undefined
  };
}

function normalizeItem(raw: unknown): ZoteroItem | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const data = asRecord(record.data) ?? record;
  const key = String(record.key ?? data.key ?? "").trim();
  if (!key) return undefined;
  const title = String(data.title ?? data.name ?? key).trim() || key;
  const creators = normalizeCreators(data.creators);
  const date = typeof data.date === "string" ? data.date : undefined;
  const year = parseYear(date);
  const doi = typeof data.DOI === "string" ? data.DOI : typeof data.doi === "string" ? data.doi : undefined;
  const missingMetadata: string[] = [];
  if (!doi?.trim()) missingMetadata.push("DOI");
  if (creators.length === 0) missingMetadata.push("creators");
  if (!date) missingMetadata.push("date");

  return {
    key,
    itemType: String(data.itemType ?? "unknown"),
    title,
    creators,
    date,
    year,
    publicationTitle:
      typeof data.publicationTitle === "string" ? data.publicationTitle : undefined,
    DOI: doi,
    url: typeof data.url === "string" ? data.url : undefined,
    abstractNote: typeof data.abstractNote === "string" ? data.abstractNote : undefined,
    tags: normalizeTags(data.tags),
    collections: Array.isArray(data.collections) ? data.collections.map(String) : [],
    parentItem: typeof data.parentItem === "string" ? data.parentItem : undefined,
    missingMetadata,
    raw: data
  };
}

function normalizeCreators(value: unknown): ZoteroCreator[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const rec = asRecord(entry) ?? {};
    return {
      creatorType: typeof rec.creatorType === "string" ? rec.creatorType : undefined,
      firstName: typeof rec.firstName === "string" ? rec.firstName : undefined,
      lastName: typeof rec.lastName === "string" ? rec.lastName : undefined,
      name: typeof rec.name === "string" ? rec.name : undefined
    };
  });
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const rec = asRecord(entry);
      return typeof rec?.tag === "string" ? rec.tag : "";
    })
    .filter(Boolean);
}

function parseYear(date?: string): number | undefined {
  if (!date) return undefined;
  const match = date.match(/(19|20)\d{2}/);
  return match ? Number.parseInt(match[0]!, 10) : undefined;
}

function formatAuthors(creators: ZoteroCreator[]): string | undefined {
  if (!creators.length) return undefined;
  return creators
    .map((c) => c.name || [c.lastName, c.firstName].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
