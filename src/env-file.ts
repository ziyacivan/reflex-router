// ~/.reflex/env: a KEY=value file for REFLEX_* settings and the decision-backend keys, merged UNDER the process environment
// (a value already in the process environment wins). This module only reads, parses and permission-checks the file;
// what a setting means is decided by src/config.ts. It never logs a value, and a file it cannot use is skipped with a
// warning: the session then runs on the process environment alone (fail-open).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultHome } from "./config.js";

export const ENV_FILE_NAME = "env";

/** The names the file may set. Anything else (Anthropic credentials, PATH, ...) is ignored: the file is reflex's, not the shell's. */
const ALLOWED_NAME = /^(REFLEX_[A-Z0-9_]+|TYPESAFE_API_KEY|TYPELLM_API_KEY)$/;
/** The decision-backend keys: a file holding either must not be readable by group or others. */
const SECRET_NAMES = ["TYPESAFE_API_KEY", "TYPELLM_API_KEY"] as const;

export interface ParsedEnvFile {
  readonly values: Readonly<Record<string, string>>;
  /** Names present in the file that are not allowed there (never their values). */
  readonly ignored: readonly string[];
  /** 1-based numbers of lines that are not `KEY=value` (never their text: it may hold a key). */
  readonly malformedLines: readonly number[];
}

/** `KEY=value` per line; `#` comments, blank lines, an optional `export `, and matching single or double quotes around a value. No interpolation. */
export function parseEnvFile(text: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const ignored: string[] = [];
  const malformedLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      malformedLines.push(i + 1);
      return;
    }
    const name = m[1]!;
    let value = m[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "").trim();
    if (!ALLOWED_NAME.test(name)) {
      if (!ignored.includes(name)) ignored.push(name);
      return;
    }
    values[name] = value;
  });
  return { values, ignored, malformedLines };
}

export interface EnvFileIO {
  /** Mode bits of the file (following symlinks), or null when it does not exist. */
  readonly stat: (file: string) => { readonly mode: number } | null;
  readonly read: (file: string) => string;
  readonly platform: NodeJS.Platform;
}

export const realEnvFileIO = (): EnvFileIO => ({
  stat: (file) => {
    try {
      return fs.statSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  read: (file) => fs.readFileSync(file, "utf8"),
  platform: process.platform,
});

export type EnvFileState = "absent" | "loaded" | "refused" | "unreadable";

export interface MergedEnv {
  /** The process environment plus every file value the process environment did not already set. */
  readonly env: NodeJS.ProcessEnv;
  readonly file: string;
  readonly state: EnvFileState;
  /** Why the file was not used (state `refused` or `unreadable`); never contains a value. */
  readonly reason: string | null;
  /** Names whose value in `env` came from the file. */
  readonly fromFile: ReadonlySet<string>;
  /** Names set in the file but overridden by the process environment. */
  readonly overridden: readonly string[];
  readonly warnings: readonly string[];
}

const modeText = (mode: number): string => `0${(mode & 0o777).toString(8)}`;
const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

/** Reads `<REFLEX_HOME or ~/.reflex>/env` and merges it under `processEnv`. Never throws. */
export function mergeEnvFile(processEnv: NodeJS.ProcessEnv, io: EnvFileIO = realEnvFileIO(), homedir: string = os.homedir()): MergedEnv {
  const file = path.join(defaultHome(processEnv, homedir), ENV_FILE_NAME);
  const result = (state: EnvFileState, extra: Partial<MergedEnv> = {}): MergedEnv => ({
    env: processEnv,
    file,
    state,
    reason: null,
    fromFile: new Set(),
    overridden: [],
    warnings: [],
    ...extra,
  });

  let st: { readonly mode: number } | null;
  let text: string;
  try {
    st = io.stat(file);
    if (st === null) return result("absent");
    text = io.read(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    const reason = `cannot read ${file} (${code})`;
    return result("unreadable", { reason, warnings: [`${reason}; using the process environment only`] });
  }

  const parsed = parseEnvFile(text);
  const warnings: string[] = [];
  if (parsed.malformedLines.length > 0) warnings.push(`${file}: ignoring line(s) ${parsed.malformedLines.join(", ")} (not KEY=value)`);
  if (parsed.ignored.length > 0) warnings.push(`${file}: ignoring ${parsed.ignored.join(", ")} (only REFLEX_* and ${SECRET_NAMES.join(", ")} are read from it)`);

  // A key file anyone else on the machine can read is refused whole: none of its values are used.
  const secret = SECRET_NAMES.find((n) => !blank(parsed.values[n]));
  if (secret !== undefined && io.platform !== "win32" && (st.mode & 0o077) !== 0) {
    const reason = `it holds ${secret} but is readable by group/others (mode ${modeText(st.mode)}); run: chmod 600 ${file}`;
    return result("refused", { reason, warnings: [...warnings, `refusing ${file}: ${reason}`] });
  }

  const env: NodeJS.ProcessEnv = { ...processEnv };
  const fromFile = new Set<string>();
  const overridden: string[] = [];
  for (const [name, value] of Object.entries(parsed.values)) {
    if (name === "REFLEX_HOME") {
      warnings.push(`${file}: REFLEX_HOME cannot be set here (it locates this file); ignored`);
      continue;
    }
    if (blank(processEnv[name])) {
      env[name] = value;
      fromFile.add(name);
    } else overridden.push(name);
  }
  return { env, file, state: "loaded", reason: null, fromFile, overridden, warnings };
}
