import { describe, expect, it } from "vitest";
import {
  FakeWebFetch,
  FakeWebSearch,
  normalizeSourceUrl,
  stripHtml,
  extractTitleFromHtml,
  WebToolError
} from "./webTools.js";

describe("webTools fakes (task 32)", () => {
  it("normalizes URLs for dedup", () => {
    expect(normalizeSourceUrl("https://Example.COM/Path/#frag")).toBe("https://example.com/Path");
    expect(normalizeSourceUrl("https://example.com/a/")).toBe("https://example.com/a");
  });

  it("strips HTML and extracts title", () => {
    const html = "<html><head><title>Hello &amp; World</title></head><body><p>Hi</p></body></html>";
    expect(extractTitleFromHtml(html)).toBe("Hello & World");
    expect(stripHtml(html)).toContain("Hi");
  });

  it("FakeWebSearch returns seeded hits without network", async () => {
    const search = new FakeWebSearch().seed([
      { title: "Alpha paper", url: "https://ex.com/a", snippet: "alpha results about widgets" },
      { title: "Beta note", url: "https://ex.com/b", snippet: "unrelated" }
    ]);
    const hits = await search.search("widgets", { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Alpha paper");
    expect(search.calls).toHaveLength(1);
  });

  it("FakeWebSearch seedQuery is exact", async () => {
    const search = new FakeWebSearch().seedQuery("quantum", [
      { title: "Q", url: "https://ex.com/q", snippet: "q" }
    ]);
    expect(await search.search("quantum")).toHaveLength(1);
    expect(await search.search("other")).toHaveLength(0);
  });

  it("FakeWebSearch rejects empty query", async () => {
    const search = new FakeWebSearch();
    await expect(search.search("  ")).rejects.toBeInstanceOf(WebToolError);
  });

  it("FakeWebFetch returns seeded pages and flags unknown as unreachable", async () => {
    const fetch = new FakeWebFetch(() => new Date("2026-01-02T00:00:00.000Z"));
    fetch.seed("https://ex.com/doc", {
      title: "Doc",
      text: "Full body about widgets and gadgets.",
      author: "Ada",
      publishedAt: "2025-12-01T00:00:00.000Z"
    });
    const page = await fetch.fetch("https://ex.com/doc/");
    expect(page.title).toBe("Doc");
    expect(page.author).toBe("Ada");
    expect(page.fetchedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(page.text).toMatch(/widgets/);

    await expect(fetch.fetch("https://missing.example/x")).rejects.toMatchObject({
      code: "unreachable"
    });
  });
});
