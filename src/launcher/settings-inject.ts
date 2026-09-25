// Builds the single `--settings` argument we hand to claude.
//
// Observed on Claude Code 2.1.277 (docs/wire-format.md §7): hooks from different settings SOURCES merge, but when
// `--settings` is passed twice the LAST flag wins wholesale. So we never add a second flag next to the user's:
// we read the user's last `--settings` value, merge ours into it, and pass exactly one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly Record<string, unknown>[];
}

export interface InjectedSettings {
  readonly env: Readonly<Record<string, string>>;
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
  /** Only set when the user has no status line of their own (`hasOwnStatusLine`); theirs always wins. */
  readonly statusLine?: Readonly<Record<string, unknown>>;
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SplitResult {
  /** argv without any --settings flag/value. */
  readonly rest: string[];
  /** The values of every --settings flag, in order. */
  readonly values: string[];
  /** Index in `rest` where the `--` terminator sits (or rest.length). New flags are inserted here. */
  readonly insertAt: number;
  /** True when a --settings flag had no value (claude will report that error itself; we stay out of the way). */
  readonly dangling: boolean;
}

export function splitSettingsArgs(argv: readonly string[]): SplitResult {
  const rest: string[] = [];
  const values: string[] = [];
  let insertAt = -1;
  let dangling = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (insertAt === -1 && a === "--") {
      insertAt = rest.length;
      rest.push(a);
      continue;
    }
    if (insertAt !== -1) {
      rest.push(a); // after `--` everything is literal
      continue;
    }
    if (a === "--settings") {
      const v = argv[i + 1];
      if (v === undefined) {
        dangling = true;
        rest.push(a);
      } else {
        values.push(v);
        i++;
      }
    } else if (a.startsWith("--settings=")) {
      values.push(a.slice("--settings=".length));
    } else {
      rest.push(a);
    }
  }
  return { rest, values, insertAt: insertAt === -1 ? rest.length : insertAt, dangling };
}

export type LoadResult = { readonly ok: true; readonly settings: JsonObject } | { readonly ok: false; readonly reason: string };

/** A --settings value is either inline JSON or a path to a JSON file. */
export function loadSettingsValue(value: string, cwd: string, readFile: (p: string) => string): LoadResult {
  let text: string;
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    text = trimmed;
  } else {
    try {
      text = readFile(path.resolve(cwd, value));
    } catch (e) {
      return { ok: false, reason: `cannot read ${value}: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? { ok: true, settings: parsed } : { ok: false, reason: "not a JSON object" };
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
}

/** Pure. `user` is what the user's (last) --settings flag contained, or null. Our env keys win; hook groups are appended. */
export function mergeSettings(user: JsonObject | null, injected: InjectedSettings): JsonObject {
  const out: JsonObject = user ? { ...user } : {};
  out["env"] = { ...(isObject(out["env"]) ? out["env"] : {}), ...injected.env };
  if (injected.hooks) {
    const hooks: JsonObject = isObject(out["hooks"]) ? { ...out["hooks"] } : {};
    for (const [event, groups] of Object.entries(injected.hooks)) {
      const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...existing, ...groups];
    }
    out["hooks"] = hooks;
  }
  if (injected.statusLine && out["statusLine"] === undefined) out["statusLine"] = { ...injected.statusLine };
  return out;
}

/** One settings file as an object; null when it is missing, empty or not a JSON object. */
export function readSettingsFile(file: string, readFile: (p: string) => string): JsonObject | null {
  try {
    const o: unknown = JSON.parse(readFile(file));
    return isObject(o) ? o : null;
  } catch {
    return null;
  }
}

/** The user's own `--settings` value (the last one, as Claude Code reads it); null when there is none or it cannot be read. */
export function userSettingsFromArgv(argv: readonly string[], cwd: string, readFile: (p: string) => string): JsonObject | null {
  const split = splitSettingsArgs(argv);
  const last = split.dangling ? undefined : split.values.at(-1);
  if (last === undefined) return null;
  const loaded = loadSettingsValue(last, cwd, readFile);
  return loaded.ok ? loaded.settings : null;
}

/**
 * Whether Claude Code's sandbox is on for the session: `sandbox.enabled` from the settings sources given in increasing
 * precedence (user, project, local project, the --settings value, managed); the last source that sets it wins.
 */
export function sandboxEnabled(sources: readonly (JsonObject | null)[]): boolean {
  let on = false;
  for (const s of sources) {
    const sb = s?.["sandbox"];
    if (isObject(sb) && typeof sb["enabled"] === "boolean") on = sb["enabled"];
  }
  return on;
}

/**
 * True when one of the user's settings files sets `statusLine`. reflex never replaces a user's status line: its own
 * `--settings` would take precedence over theirs. `files` are the user and project settings files (read, never edited);
 * one that is missing or unreadable counts as having none.
 * ponytail: project files are looked up in the launch directory only, not its parents; a status line set further up
 * would be hidden by reflex's (REFLEX_STATUSLINE=0 turns it off).
 */
export function hasOwnStatusLine(files: readonly string[], readFile: (p: string) => string): boolean {
  return files.some((f) => readSettingsFile(f, readFile)?.["statusLine"] !== undefined);
}

export interface InjectIO {
  readonly cwd: string;
  readonly readFile: (p: string) => string;
  /** Writes the merged settings somewhere private and returns its path plus a cleanup function. */
  readonly writeTemp: (json: string) => { file: string; cleanup: () => void };
}

export const realInjectIO = (cwd: string): InjectIO => ({
  cwd,
  readFile: (p) => fs.readFileSync(p, "utf8"),
  writeTemp: (json) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-")); // created 0700
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, json, { mode: 0o600 });
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  },
});

export interface InjectResult {
  readonly args: string[];
  readonly injected: boolean;
  readonly warning: string | null;
  readonly cleanup: () => void;
}

/** Returns the argv to give claude. Falls back to the untouched argv (and says why) if the user's flag cannot be merged. */
export function injectSettings(argv: readonly string[], injected: InjectedSettings, io: InjectIO): InjectResult {
  const untouched = (warning: string | null): InjectResult => ({ args: [...argv], injected: false, warning, cleanup: () => undefined });
  const split = splitSettingsArgs(argv);
  if (split.dangling) return untouched(null);

  let user: JsonObject | null = null;
  const last = split.values.at(-1);
  if (last !== undefined) {
    const loaded = loadSettingsValue(last, io.cwd, io.readFile);
    if (!loaded.ok) return untouched(`could not merge your --settings value (${loaded.reason}); running without reflex's settings injection`);
    user = loaded.settings;
  }
  const { file, cleanup } = io.writeTemp(JSON.stringify(mergeSettings(user, injected)));
  const args = [...split.rest];
  args.splice(split.insertAt, 0, "--settings", file);
  return { args, injected: true, warning: null, cleanup };
}
