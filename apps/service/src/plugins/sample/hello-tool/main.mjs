/**
 * Minimal sample plugin (Task 46).
 * In-process module: exports contributions + request handler.
 * Also runnable as stdio when entry.type is switched to "stdio".
 */

const contributions = {
  tools: [
    {
      id: "hello.greet",
      name: "hello.greet",
      description: "Return a friendly greeting for the local workbench.",
      category: "readonly",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        }
      }
    }
  ]
};

export async function handle(request) {
  if (request.kind === "tool.hello.greet" || request.kind === "hello.greet") {
    const name =
      request.payload && typeof request.payload.name === "string" && request.payload.name.trim()
        ? request.payload.name.trim()
        : "Workbench";
    return { message: `Hello, ${name}!`, pluginId: "hello-tool" };
  }
  if (request.kind === "plugin.contributions") {
    return { contributes: contributions };
  }
  if (request.kind === "plugin.ping") {
    return { pong: true, pluginId: "hello-tool" };
  }
  throw new Error(`hello-tool: unhandled kind "${request.kind}"`);
}

export { contributions };
export default { handle, contributions };

// Stdio mode when executed directly: node main.mjs
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("main.mjs") || process.argv[1].includes("hello-tool"));

if (isMain && process.env.PAW_PLUGIN_STDIO === "1") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void (async () => {
        let requestId = "";
        try {
          const parsed = JSON.parse(line);
          requestId = parsed.requestId;
          const data = await handle({
            requestId,
            pluginId: parsed.pluginId ?? "hello-tool",
            kind: parsed.kind,
            payload: parsed.payload ?? {}
          });
          process.stdout.write(
            JSON.stringify({ type: "response", requestId, ok: true, data }) + "\n"
          );
        } catch (error) {
          process.stdout.write(
            JSON.stringify({
              type: "response",
              requestId,
              ok: false,
              error: { message: error instanceof Error ? error.message : String(error) }
            }) + "\n"
          );
        }
      })();
    }
  });
}
