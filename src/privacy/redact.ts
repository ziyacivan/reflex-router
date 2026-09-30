// Best-effort secret redaction for text that leaves the machine (decision backend) or reaches a log. Not a guarantee:
// entropy-based detection is deliberately out of scope because false positives would corrupt the task text.
// Runs AFTER truncation (budget.ts) and BEFORE the decision state is built. Pure.

interface Rule {
  readonly kind: string;
  readonly re: RegExp;
  /** Replacement; default `[REDACTED:<kind>]`. `$1` etc. keep a prefix (e.g. the variable name of an .env line). */
  readonly replacement?: string;
}

const RULES: readonly Rule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "typesafe_key", re: /\bapikey_[A-Za-z0-9_-]{8,}/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: "typellm_key", re: /\btl-sk-[A-Za-z0-9_-]{8,}/g },
  { kind: "api_key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: "aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "google_key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "auth_header", re: /\b(Authorization|Proxy-Authorization)(\s*[:=]\s*)\S+(?:\s+\S+)?/gi, replacement: "$1$2[REDACTED:auth_header]" },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  // Home-directory prefixes carry the OS username: /Users/<name>, /home/<name>, C:\Users\<name> -> ~
  { kind: "home_path", re: /(?:\/Users|\/home)\/[^/\s"'`]+|\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, replacement: "~" },
  // .env-style assignment lines: every such line's value, not just key-named ones (deliberately over-eager).
  { kind: "env_value", re: /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*).+$/gm, replacement: "$1[REDACTED:env_value]" },
];

export function redact(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.replacement ?? `[REDACTED:${r.kind}]`);
  return out;
}
