/**
 * Production web search / fetch ports for ResearchService.
 * DuckDuckGo Instant Answer API for search (no API key); native fetch for pages.
 */

import type { WebPageContent, WebSearchHit } from "./researchTypes.js";
import {
  extractTitleFromHtml,
  normalizeSourceUrl,
  stripHtml,
  WebToolError,
  type WebFetchOptions,
  type WebFetchPort,
  type WebSearchOptions,
  type WebSearchPort
} from "./webTools.js";

export function createHttpWebFetch(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): WebFetchPort {
  return {
    async fetch(url: string, options?: WebFetchOptions): Promise<WebPageContent> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new WebToolError(`Invalid URL: ${url}`, "invalid_url");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new WebToolError(`Unsupported URL protocol: ${parsed.protocol}`, "invalid_url");
      }
      let response: Response;
      try {
        response = await fetchImpl(parsed.toString(), {
          signal: options?.signal,
          headers: { "User-Agent": "PersonalAIWorkbench-Research/0.1" },
          redirect: "follow"
        });
      } catch {
        throw new WebToolError(`Unable to reach ${parsed.toString()}`, "unreachable");
      }
      if (response.status === 404) {
        throw new WebToolError(`Page not found: ${parsed.toString()}`, "not_found");
      }
      if (!response.ok) {
        throw new WebToolError(`HTTP ${response.status} for ${parsed.toString()}`, "unreachable");
      }
      const html = await response.text();
      const maxChars = options?.maxChars ?? 40_000;
      const text = stripHtml(html).slice(0, maxChars);
      const title = extractTitleFromHtml(html) ?? parsed.toString();
      return {
        url: normalizeSourceUrl(parsed.toString()) || parsed.toString(),
        title,
        text,
        fetchedAt: new Date().toISOString()
      };
    }
  };
}

export function createHttpWebSearch(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): WebSearchPort {
  return {
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchHit[]> {
      const q = query.trim();
      if (!q) throw new WebToolError("Search query must not be empty.", "empty_query");
      const limit = options?.limit ?? 10;
      const endpoint = new URL("https://api.duckduckgo.com/");
      endpoint.searchParams.set("q", q);
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("no_redirect", "1");
      endpoint.searchParams.set("no_html", "1");

      let response: Response;
      try {
        response = await fetchImpl(endpoint.toString(), {
          signal: options?.signal,
          headers: { "User-Agent": "PersonalAIWorkbench-Research/0.1", Accept: "application/json" }
        });
      } catch {
        throw new WebToolError("Web search request failed.", "unreachable");
      }
      if (!response.ok) {
        throw new WebToolError(`Web search returned HTTP ${response.status}.`, "unreachable");
      }
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data) return [];

      const hits: WebSearchHit[] = [];
      const push = (title: string, url: string, snippet: string) => {
        const normalized = normalizeSourceUrl(url) || url;
        if (!normalized || hits.some((h) => h.url === normalized)) return;
        hits.push({
          title: title || normalized,
          url: normalized,
          snippet: snippet || title
        });
      };

      if (typeof data.AbstractURL === "string" && data.AbstractURL) {
        push(
          String(data.Heading ?? data.AbstractURL),
          data.AbstractURL,
          String(data.AbstractText ?? "")
        );
      }
      const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
      flattenRelated(related, push);

      return hits.slice(0, limit);
    }
  };
}

function flattenRelated(
  items: unknown[],
  push: (title: string, url: string, snippet: string) => void
): void {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (Array.isArray(rec.Topics)) {
      flattenRelated(rec.Topics, push);
      continue;
    }
    if (typeof rec.FirstURL === "string" && rec.FirstURL) {
      const text = typeof rec.Text === "string" ? rec.Text : "";
      push(text.split(" - ")[0] || rec.FirstURL, rec.FirstURL, text);
    }
  }
}
