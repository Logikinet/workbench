import { createJsonRequest } from "./apiClient.js";

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  enabled: boolean;
  trusted: boolean;
  tags: string[];
  requiredTools: string[];
  permissionHints: string[];
  author?: string;
  catalogId?: string;
  installStatus?: string;
  updatedAt?: string;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  author?: string;
  recommended?: boolean;
  requiredTools: string[];
  permissionHints: string[];
}

export function createSkillClient(serviceUrl: string) {
  const json = createJsonRequest(serviceUrl);

  return {
    list: async () => {
      const body = await json<{ skills: SkillRecord[] }>("/api/skills");
      return body.skills ?? [];
    },
    catalog: async (q?: string) => {
      const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const body = await json<{
        entries?: SkillCatalogEntry[];
        catalogAvailable?: boolean;
      }>(`/api/skills/catalog${qs}`);
      return body.entries ?? [];
    },
    enable: (id: string) =>
      json(`/api/skills/${encodeURIComponent(id)}/enable`, { method: "POST", body: "{}" }),
    disable: (id: string) =>
      json(`/api/skills/${encodeURIComponent(id)}/disable`, { method: "POST", body: "{}" }),
    trust: (id: string) =>
      json(`/api/skills/${encodeURIComponent(id)}/trust`, { method: "POST", body: "{}" }),
    revokeTrust: (id: string) =>
      json(`/api/skills/${encodeURIComponent(id)}/revoke-trust`, { method: "POST", body: "{}" }),
    installFromCatalog: (catalogId: string) =>
      json("/api/skills/catalog/install", {
        method: "POST",
        body: JSON.stringify({ catalogId, confirm: true })
      }),
    detail: (id: string) => json(`/api/skills/${encodeURIComponent(id)}/detail`)
  };
}
