/**
 * Minimal JSON Schema validator for structured model output.
 * Supports a practical subset (draft-07 style) without external dependencies.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema | undefined | null): SchemaValidationResult {
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected const value`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    errors.push(`${path}: value is not in enum`);
    return;
  }

  const type = schema.type;
  if (typeof type === "string") {
    if (!matchesType(value, type)) {
      errors.push(`${path}: expected type ${type}`);
      return;
    }
  } else if (Array.isArray(type)) {
    if (!type.some((entry) => typeof entry === "string" && matchesType(value, entry))) {
      errors.push(`${path}: expected one of types ${type.join("|")}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: string does not match pattern`);
      } catch {
        errors.push(`${path}: invalid schema pattern`);
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: number below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: number above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      validateNode(value[index], schema.items as JsonSchema, `${path}[${index}]`, errors);
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) validateNode(record[key], childSchema, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
      for (const [key, child] of Object.entries(record)) {
        if (!(key in properties)) validateNode(child, schema.additionalProperties as JsonSchema, `${path}.${key}`, errors);
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left as object);
    const rightKeys = Object.keys(right as object);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

/** Extract JSON object/array from raw model text (plain JSON or fenced code block). */
export function extractJsonCandidate(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced?.trim()) return fenced.trim();
  const trimmed = text.trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  let start = -1;
  if (objectStart >= 0 && arrayStart >= 0) start = Math.min(objectStart, arrayStart);
  else start = Math.max(objectStart, arrayStart);
  if (start < 0) return trimmed;
  return trimmed.slice(start);
}

export function parseAndValidateJson(text: string, schema?: JsonSchema | null): { ok: true; value: unknown } | { ok: false; message: string } {
  const candidate = extractJsonCandidate(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, message: "Model output is not valid JSON." };
  }
  const validation = validateAgainstSchema(parsed, schema);
  if (!validation.valid) {
    return { ok: false, message: `Model output failed schema validation: ${validation.errors.slice(0, 5).join("; ")}` };
  }
  return { ok: true, value: parsed };
}
