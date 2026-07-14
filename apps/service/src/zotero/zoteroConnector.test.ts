import { describe, expect, it, vi } from "vitest";
import { ZoteroConnector } from "./zoteroConnector.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("Zotero Local Connector (Task 49)", () => {
  it("probes local API and reports not running on connection failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const z = new ZoteroConnector({ fetchImpl });
    const status = await z.probe();
    expect(status.running).toBe(false);
    expect(status.detail).toMatch(/not running|unavailable|ECONNREFUSED/i);
  });

  it("lists collections from local API without SQLite", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/collections")) {
        return jsonResponse([
          { key: "COL1", data: { name: "Papers", parentCollection: false } },
          { key: "COL2", data: { name: "Nested", parentCollection: "COL1" } }
        ]);
      }
      return jsonResponse([]);
    });
    const z = new ZoteroConnector({ fetchImpl });
    const cols = await z.listCollections();
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({ key: "COL1", name: "Papers" });
    expect(cols[1]?.parentCollection).toBe("COL1");
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(/23119\/api/);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toMatch(/sqlite/i);
  });

  it("searches items, filters DOI/year, and flags missing metadata", async () => {
    const listBody = [
      {
        key: "ABCD1234",
        data: {
          itemType: "journalArticle",
          title: "Harness Design",
          creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
          date: "2024-03-01",
          DOI: "10.1000/test",
          publicationTitle: "AI Systems",
          tags: [{ tag: "agents" }],
          collections: ["COL1"]
        }
      },
      {
        key: "NODOI999",
        data: {
          itemType: "journalArticle",
          title: "No DOI Paper",
          creators: [],
          date: "2010",
          tags: [],
          collections: []
        }
      }
    ];
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/items/NODOI999")) {
        return jsonResponse({
          key: "NODOI999",
          data: {
            itemType: "journalArticle",
            title: "No DOI Paper",
            creators: [],
            date: "2010",
            tags: [],
            collections: []
          }
        });
      }
      if (u.includes("/collections")) return jsonResponse([]);
      return jsonResponse(listBody);
    });
    const z = new ZoteroConnector({ fetchImpl });
    const items = await z.searchItems({ q: "Harness", requireDoi: true, yearFrom: 2020 });
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe("ABCD1234");
    expect(items[0]!.missingMetadata).toEqual([]);

    const item = await z.getItem("NODOI999");
    expect(item.missingMetadata).toEqual(expect.arrayContaining(["DOI", "creators"]));
  });

  it("reads children and fulltext when available", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/items/ABCD1234/children") || u.includes("/children")) {
        return jsonResponse([
          {
            key: "ATT1",
            data: { itemType: "attachment", title: "PDF", parentItem: "ABCD1234", contentType: "application/pdf" }
          }
        ]);
      }
      if (u.includes("/fulltext")) {
        return jsonResponse({ content: "Full text body from index.", indexedPages: 12, indexedChars: 4000 });
      }
      if (u.includes("/items/ABCD1234") && !u.includes("children")) {
        return jsonResponse({
          key: "ABCD1234",
          data: { itemType: "journalArticle", title: "Harness Design", creators: [], tags: [], collections: [] }
        });
      }
      return jsonResponse({});
    });
    const z = new ZoteroConnector({ fetchImpl });
    const children = await z.getChildren("ABCD1234");
    expect(children[0]?.key).toBe("ATT1");
    const full = await z.getFullText("ATT1");
    expect(full?.available).toBe(true);
    expect(full?.content).toMatch(/Full text/);
  });

  it("builds evidence seeds from real item keys only", async () => {
    const z = new ZoteroConnector({
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          key: "ABCD1234",
          data: {
            itemType: "journalArticle",
            title: "Harness Design",
            creators: [{ lastName: "Lovelace", firstName: "Ada" }],
            date: "2024",
            DOI: "10.1000/test",
            abstractNote: "Tools improve stability.",
            url: "https://example.com/paper",
            tags: [],
            collections: []
          }
        })
      )
    });
    const seed = await z.toEvidenceSeed("ABCD1234");
    expect(seed.itemKey).toBe("ABCD1234");
    expect(seed.origin).toBe("zotero");
    expect(seed.excerpt).toMatch(/Tools improve/);
    expect(seed.doi).toBe("10.1000/test");
  });

  it("never invents items when API returns empty", async () => {
    const z = new ZoteroConnector({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse([]))
    });
    const items = await z.searchItems({ q: "nonexistent-topic-xyz" });
    expect(items).toEqual([]);
  });
});
