/** Minimal secret redaction for CLI stdout. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-***")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=***");
}

export function assertNoApiKeyFlag(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--api-key" || a.startsWith("--api-key=") || a === "-k") {
      throw new Error(
        "禁止通过 --api-key 传入明文密钥。请使用交互式输入或环境变量引用。"
      );
    }
  }
}
