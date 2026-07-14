/**
 * Web search + page fetch ports for research (Task 32).
 *
 * Production code injects real MCP/http implementations later.
 * Tests use FakeWebSearch / FakeWebFetch — never hit the network.
 */

import type { WebPageContent, WebSearchHit } from "./researchTypes.js";

export interface WebSearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface WebSearchPort {
  search(query: string, options?: WebSearchOptions): Promise<WebSearchHit[]>;
}

export interface WebFetchOptions {
  signal?: AbortSignal;
  /** Max characters of body text to retain. */
  maxChars?: number;
}

export interface WebFetchPort {
  fetch(url: string, options?: WebFetchOptions): Promise<WebPageContent>;
}

export class WebToolError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "unreachable" | "invalid_url" | "empty_query"
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

/** Normalize URL for dedup (strip hash, trailing slash, lowercase host). */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    u.pathname = path;
    // Drop default ports
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    return u.toString();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

/** Strip crude HTML tags for tests / fallback extractors. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTitleFromHtml(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  return stripHtml(m[1]).trim() || undefined;
}

/**
 * In-memory fake search engine for unit tests.
 * Register hits with `seed` / `seedQuery`.
 */
export class FakeWebSearch implements WebSearchPort {
  private readonly byQuery = new Map<string, WebSearchHit[]>();
  private readonly global: WebSearchHit[] = [];
  readonly calls: Array<{ query: string; limit?: number }> = [];

  seed(hits: WebSearchHit[]): this {
    this.global.push(...hits);
    return this;
  }

  seedQuery(query: string, hits: WebSearchHit[]): this {
    this.byQuery.set(query.trim().toLowerCase(), hits);
    return this;
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchHit[]> {
    const q = query.trim();
    if (!q) throw new WebToolError("Search query must not be empty.", "empty_query");
    this.calls.push({ query: q, limit: options?.limit });
    const limit = options?.limit ?? 10;
    const specific = this.byQuery.get(q.toLowerCase());
    const pool = specific ?? this.global.filter((hit) => {
      const hay = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
      return q.toLowerCase().split(/\s+/).every((token) => hay.includes(token));
    });
    return pool.slice(0, limit).map((hit) => ({ ...hit, url: normalizeSourceUrl(hit.url) || hit.url }));
  }
}

/**
 * In-memory fake page fetcher. `seed(url, content)` registers pages.
 * Unknown URLs throw WebToolError unreachable (tests can assert flagging).
 */
export class FakeWebFetch implements WebFetchPort {
  private readonly pages = new Map<string, Omit<WebPageContent, "fetchedAt" | "url"> & { url?: string }>();
  readonly calls: string[] = [];
  private now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  seed(
    url: string,
    content: {
      title: string;
      text: string;
      author?: string;
      publishedAt?: string;
      statusCode?: number;
      contentType?: string;
    }
  ): this {
    this.pages.set(normalizeSourceUrl(url) || url, { ...content, url });
    return this;
  }

  async fetch(url: string, options?: WebFetchOptions): Promise<WebPageContent> {
    const normalized = normalizeSourceUrl(url) || url;
    if (!normalized) throw new WebToolError("URL is required.", "invalid_url");
    this.calls.push(normalized);
    const page = this.pages.get(normalized);
    if (!page) {
      throw new WebToolError(`Unable to fetch “${url}”.`, "unreachable");
    }
    const maxChars = options?.maxChars ?? 50_000;
    const text = page.text.length > maxChars ? page.text.slice(0, maxChars) : page.text;
    return {
      url: normalized,
      title: page.title,
      author: page.author,
      publishedAt: page.publishedAt,
      text,
      fetchedAt: this.now().toISOString(),
      statusCode: page.statusCode ?? 200,
      contentType: page.contentType ?? "text/html"
    };
  }
}
