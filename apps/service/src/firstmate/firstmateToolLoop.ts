/**
 * Bridge Firstmate self-management tools into the Professional Agent tool loop.
 * Model-callable names match the Firstmate tool catalog (e.g. roles.list).
 */

import type { ToolDefinition, ToolRisk } from "../execution/toolLoop.js";
import type { FirstmateSelfManagementService } from "./firstmateSelfManagementService.js";
import { FIRSTMATE_TOOL_SPECS, invokeFirstmateTool } from "./firstmateTools.js";
import type { FirstmateToolRisk } from "./firstmateTypes.js";

function mapRisk(risk: FirstmateToolRisk): ToolRisk {
  if (risk === "dangerous") return "dangerous";
  if (risk === "write") return "write";
  return "read";
}

/**
 * Expose every Firstmate self-management tool as a ToolDefinition for runToolLoop.
 */
export function createFirstmateLoopTools(service: FirstmateSelfManagementService): ToolDefinition[] {
  return FIRSTMATE_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: `[Firstmate 自管理] ${spec.description}`,
    risk: mapRisk(spec.risk),
    async execute(args) {
      const result = await invokeFirstmateTool(service, spec.name, args ?? {});
      const payload = result.ok
        ? JSON.stringify(result.data ?? { ok: true }, null, 0)
        : JSON.stringify({ error: result.error ?? result.summary, code: result.code }, null, 0);
      return {
        ok: result.ok,
        summary: clip(`${result.summary}\n${payload}`, 12_000),
        data: result.data,
        truncated: Buffer.byteLength(payload, "utf8") > 12_000
      };
    }
  }));
}

/** True when the selected agent should receive Firstmate management tools. */
export function selectionShouldReceiveFirstmateTools(selection: {
  name: string;
  tools?: string[];
  responsibility?: string;
}): boolean {
  if (/firstmate/i.test(selection.name)) return true;
  if (/首席|编排|调度|chief/i.test(selection.name)) return true;
  if (/firstmate|编排|调度/.test(selection.responsibility ?? "")) return true;
  const tools = selection.tools ?? [];
  return tools.some((tool) =>
    /firstmate|roles\.|self[-_]?manage|orchestration/i.test(tool)
  );
}

function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out, "utf8") > maxBytes - 20 && out.length > 0) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return `${out}\n…(truncated)`;
}
