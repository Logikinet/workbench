/**
 * Shared secret redaction for model invocation logs, timeline text, and persistable events.
 * Never log Authorization headers, API keys, cookies, or connection credentials.
 */

const secretPatterns: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /-----BEGIN [\s\S]*?-----END [\s\S]*?-----/g, replacement: "[REDACTED PEM BLOCK]" },
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+[a-z0-9]+)?|redis|amqps?):\/\/[^\s'"`]+/gi,
    replacement: "[REDACTED CONNECTION URI]"
  },
  {
    pattern:
      /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{16,})\b/g,
    replacement: "[REDACTED]"
  },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: "[REDACTED]" },
  {
    // multiline so each header line is redacted independently
    pattern: /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*.+$/gim,
    replacement: "$1: [REDACTED]"
  },
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._-]+/gi, replacement: "$1 [REDACTED]" },
  {
    pattern:
      /\b([A-Za-z_][A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|private[_-]?key|database[_-]?url|connection(?:[_-]?string)?|key))\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
    replacement: "$1: [REDACTED]"
  }
];

/** Redact known secret shapes from free-form text destined for logs/timeline/backups. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const { pattern, replacement } of secretPatterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Deep-clone a JSON-safe value and redact string leaves. */
export function redactJsonValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = redactJsonValue(entry);
    }
    return out as T;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|authorization|cookie|set-cookie|credential|password|secret|token|access[_-]?key)$/i.test(key);
}
