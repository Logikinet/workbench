/**
 * Interactive prompts aligned with todos CLI UX:
 *  - ↑/↓ arrow selection (raw-mode TTY)
 *  - type-to-filter searchable lists
 *  - $ENV_VAR / !shell-command secret indirection
 *
 * Windows note: never mix readline.createInterface with setRawMode on the same
 * stdin without exclusive ownership, and never input.pause() after raw mode —
 * that triggers UV_HANDLE_CLOSING (async.c) crashes on Node for Windows.
 */

import { spawn } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

export type Choice = { id: string; label: string; hint?: string };

/** Serialize all stdin owners so raw-mode and line prompts never overlap. */
let stdinChain: Promise<void> = Promise.resolve();

async function withStdinLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = stdinChain;
  stdinChain = previous.then(() => gate);
  await previous;
  try {
    return await fn();
  } finally {
    restoreCookedMode();
    release();
  }
}

function restoreCookedMode(): void {
  try {
    if (input.isTTY && typeof input.setRawMode === "function" && input.isRaw) {
      input.setRawMode(false);
    }
  } catch {
    /* ignore */
  }
  try {
    output.write("\x1b[?25h"); // show cursor
  } catch {
    /* ignore */
  }
}

/** Safe process exit after stdin handles settle (Windows UV_HANDLE_CLOSING). */
export function safeExit(code: number): never {
  restoreCookedMode();
  // Drain microtasks / close handles before exit
  setImmediate(() => {
    try {
      process.exit(code);
    } catch {
      process.exit(code);
    }
  });
  // Keep the type checker happy; process will exit on next tick.
  return undefined as never;
}

export async function promptLine(question: string, defaultValue?: string): Promise<string> {
  return withStdinLock(async () => {
    restoreCookedMode();
    const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    // Prefer raw question() without createInterface when possible — but createInterface
    // is fine if we never leave stdin paused and always close the interface first.
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${question}${suffix}: `, (value) => {
          resolve((value ?? "").trim());
        });
      });
      return answer || defaultValue || "";
    } finally {
      rl.close();
      // Do NOT pause stdin — leaves broken state for the next raw-mode session on Windows.
    }
  });
}

/** Hidden password-style input (best-effort on Windows terminals). */
export async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return promptLine(question);
  }

  return withStdinLock(async () => {
    output.write(`${question}: `);
    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          input.removeListener("keypress", onKeypress);
        } catch {
          /* ignore */
        }
        restoreCookedMode();
        // Let libuv drop the handle before the next prompt / fetch / exit.
        setImmediate(fn);
      };

      const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
        if (key?.ctrl && key.name === "c") {
          finish(() => {
            output.write("\n");
            reject(new Error("Cancelled."));
          });
          return;
        }
        if (key?.name === "return" || key?.name === "enter") {
          finish(() => {
            output.write("\n");
            resolve(chunks.join(""));
          });
          return;
        }
        if (key?.name === "backspace") {
          if (chunks.length) {
            chunks.pop();
            output.write("\b \b");
          }
          return;
        }
        // printable
        if (str && str.length === 1 && str >= " ") {
          chunks.push(str);
          output.write("*");
        }
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
    });
  });
}

/**
 * todos-style secret: literal key, $ENV_VAR, or !shell-command.
 * Never logs the resolved secret.
 */
export async function promptSecretIndirection(
  question: string,
  options: { allowEmpty?: boolean } = {}
): Promise<{
  value: string;
  mode: "literal" | "env" | "shell" | "empty";
  envVar?: string;
}> {
  output.write("  (tip: paste a literal key, or use $ENV_VAR / !shell-command for indirection)\n");
  const raw = await promptSecret(question);
  const trimmed = raw.trim();
  if (!trimmed) {
    if (options.allowEmpty) return { value: "", mode: "empty" };
    throw new Error("API key cannot be empty.");
  }
  // $ENV_VAR or ${ENV_VAR}
  const envMatch =
    trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ||
    trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envMatch) {
    const name = envMatch[1]!;
    const v = process.env[name];
    if (!v) throw new Error(`Environment variable ${name} is not set.`);
    return { value: v, mode: "env", envVar: name };
  }
  if (trimmed.startsWith("!") && trimmed.length > 1) {
    const cmd = trimmed.slice(1);
    const value = (await runShellCapture(cmd)).trim();
    if (!value) throw new Error("Shell command produced an empty secret.");
    return { value, mode: "shell" };
  }
  return { value: trimmed, mode: "literal" };
}

function runShellCapture(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Shell command failed (exit ${code}): ${err.trim() || "no stderr"}`));
        return;
      }
      resolve(out);
    });
  });
}

/** Numbered fallback when not a TTY. */
async function promptSelectNumbered(question: string, choices: Choice[]): Promise<string> {
  output.write(`${question}\n`);
  choices.forEach((c, i) => {
    const hint = c.hint ? ` — ${c.hint}` : "";
    output.write(`  ${i + 1}) ${c.label}${hint}\n`);
  });
  while (true) {
    const answer = (await promptLine("Number")).trim();
    const index = Number.parseInt(answer, 10);
    if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1]!.id;
    }
    output.write("Invalid choice, try again.\n");
  }
}

/**
 * Arrow-key select (todos / inquirer style).
 * ↑↓ move · Enter confirm · Esc cancel · type to filter (when searchable).
 */
export async function promptSelect(
  question: string,
  choices: Choice[],
  options: { searchable?: boolean } = {}
): Promise<string> {
  if (choices.length === 0) throw new Error("No choices available.");
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return promptSelectNumbered(question, choices);
  }
  return arrowSelect(question, choices, { searchable: options.searchable === true });
}

/** Searchable preset picker with ↑↓ + type-to-filter. */
export async function promptSearchSelect(question: string, choices: Choice[]): Promise<string> {
  return promptSelect(question, choices, { searchable: true });
}

/** Prefer simple Y/n for confirms — fewer raw-mode transitions on Windows. */
export async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await promptLine(`${question} (${hint})`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  return defaultYes;
}

// ─── raw-mode arrow select ───────────────────────────────────────────

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CURSOR_UP = (n: number) => (n > 0 ? `\x1b[${n}A` : "");

function arrowSelect(
  question: string,
  choices: Choice[],
  options: { searchable: boolean }
): Promise<string> {
  return withStdinLock(async () => {
    return await new Promise<string>((resolve, reject) => {
      let filter = "";
      let cursor = 0;
      let renderedLines = 0;
      let closed = false;

      const maxVisible = Math.min(12, Math.max(choices.length, 1));

      const filtered = (): Choice[] => {
        if (!filter) return choices;
        const q = filter.toLowerCase();
        return choices.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.label.toLowerCase().includes(q) ||
            (c.hint?.toLowerCase().includes(q) ?? false)
        );
      };

      const paint = (first = false) => {
        const list = filtered();
        if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
        if (cursor < 0) cursor = 0;

        if (!first && renderedLines > 0) {
          output.write(CURSOR_UP(renderedLines));
        }

        const lines: string[] = [];
        lines.push(question);
        if (options.searchable) {
          lines.push(
            `  Filter: ${filter || "(type to search)"}  · ↑↓ · Enter · Esc`
          );
        } else {
          lines.push("  ↑↓ move · Enter select · Esc cancel");
        }

        if (list.length === 0) {
          lines.push("  (no matches)");
        } else {
          let start = 0;
          if (list.length > maxVisible) {
            start = Math.max(
              0,
              Math.min(cursor - Math.floor(maxVisible / 2), list.length - maxVisible)
            );
          }
          const end = Math.min(list.length, start + maxVisible);
          if (start > 0) lines.push(`  … ${start} more above`);
          for (let i = start; i < end; i++) {
            const c = list[i]!;
            const hint = c.hint ? ` — ${c.hint}` : "";
            const prefix = i === cursor ? "❯ " : "  ";
            const body = `${prefix}${c.label}${hint}`;
            lines.push(i === cursor ? `\x1b[36m${body}\x1b[0m` : body);
          }
          if (end < list.length) lines.push(`  … ${list.length - end} more below`);
        }

        for (let i = 0; i < lines.length; i++) {
          output.write(CLEAR_LINE + lines[i] + "\n");
        }
        if (renderedLines > lines.length) {
          for (let i = lines.length; i < renderedLines; i++) {
            output.write(CLEAR_LINE + "\n");
          }
          output.write(CURSOR_UP(renderedLines - lines.length));
          renderedLines = lines.length;
        } else {
          renderedLines = lines.length;
        }
      };

      const finish = (fn: () => void) => {
        if (closed) return;
        closed = true;
        try {
          input.removeListener("keypress", onKeypress);
        } catch {
          /* ignore */
        }
        restoreCookedMode();
        output.write(SHOW_CURSOR);
        // Critical on Windows: delay resolve until after UV handle close.
        setImmediate(fn);
      };

      const onKeypress = (
        str: string | undefined,
        key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } | undefined
      ) => {
        if (closed) return;

        if (key?.ctrl && key.name === "c") {
          finish(() => reject(new Error("Cancelled.")));
          return;
        }
        if (key?.name === "escape") {
          finish(() => reject(new Error("Cancelled.")));
          return;
        }
        if (key?.name === "up") {
          const list = filtered();
          if (list.length) cursor = (cursor - 1 + list.length) % list.length;
          paint();
          return;
        }
        if (key?.name === "down") {
          const list = filtered();
          if (list.length) cursor = (cursor + 1) % list.length;
          paint();
          return;
        }
        if (key?.name === "pageup") {
          cursor = Math.max(0, cursor - maxVisible);
          paint();
          return;
        }
        if (key?.name === "pagedown") {
          const list = filtered();
          cursor = Math.min(Math.max(0, list.length - 1), cursor + maxVisible);
          paint();
          return;
        }
        if (key?.name === "return" || key?.name === "enter") {
          const list = filtered();
          if (!list.length) return;
          const chosen = list[cursor]!;
          finish(() => {
            output.write(`  → ${chosen.label}\n`);
            resolve(chosen.id);
          });
          return;
        }
        if (key?.name === "backspace") {
          if (options.searchable && filter.length) {
            filter = filter.slice(0, -1);
            cursor = 0;
            paint();
          }
          return;
        }

        // Printable filter chars (ignore pure control sequences)
        if (options.searchable && str && str.length === 1 && str >= " " && !key?.ctrl && !key?.meta) {
          filter += str;
          cursor = 0;
          paint();
        }
      };

      emitKeypressEvents(input);
      output.write(HIDE_CURSOR);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      paint(true);
    });
  });
}
