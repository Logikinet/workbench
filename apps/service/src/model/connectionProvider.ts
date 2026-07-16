import type { ConnectionService } from "../connections/connectionService.js";
import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "./types.js";

/**
 * Real provider backed by an OpenAI-compatible Model Connection.
 * Credentials stay in ConnectionService/vault — never returned from complete().
 */
export class ConnectionModelProvider implements ModelProvider {
  constructor(private readonly connections: ConnectionService) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    if (request.signal?.aborted) {
      throw Object.assign(new Error("Model invocation was cancelled."), { kind: "cancelled" as const, name: "AbortError" });
    }
    const detailed = await this.connections.chatCompletionDetailed(request.connectionId, {
      modelId: request.modelId,
      signal: request.signal,
      messages: request.messages.map((message) => {
        if (message.role === "assistant") {
          // ConnectionService currently accepts system|user; fold assistant into user for compatibility.
          return { role: "user" as const, content: `Assistant:\n${message.content}` };
        }
        return { role: message.role, content: message.content };
      })
    });
    return { content: detailed.content, usage: detailed.usage };
  }
}
