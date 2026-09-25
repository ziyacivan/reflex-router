// `reflex hook-relay <url>`: the command hook reflex injects instead of its http hooks when Claude Code's sandbox is on.
// Under the sandbox Claude Code sends http hooks through the sandbox's network allowlist, so one to 127.0.0.1 comes back
// "HTTP 403" and never reaches the door; a command hook is a process Claude Code starts itself and reaches loopback
// (docs/observations.md, 2026-09-24). This relays one hook event, the JSON Claude Code writes to the hook's stdin, to the
// door exactly as the http hook would, and prints the door's answer to stdout. It never fails the hook: every error
// ends in exit 0 with nothing printed, which Claude Code reads as "no hook output".
import http from "node:http";

/** Under HOOK_TIMEOUT_S (src/outcome/hooks-config.ts), so Claude Code never has to kill the relay. */
export const RELAY_DEADLINE_MS = 1500;

/**
 * Pure apart from the one loopback request. Returns what the hook prints: the door's 200 body when it is a JSON object
 * (the delegation hint, the model-change notice), else "". For a UserPromptSubmit command hook Claude Code adds plain
 * stdout to the model's context, so anything that is not a JSON object must print nothing.
 */
export async function relayHook(input: Buffer, target: string, deadlineMs: number = RELAY_DEADLINE_MS): Promise<string> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return ""; // loopback only
  const body = await new Promise<string | null>((resolve) => {
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": input.length }, timeout: deadlineMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : null));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(input);
  });
  if (body === null) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? body : "";
  } catch {
    return "";
  }
}

export async function hookRelayCommand(args: readonly string[], io: { readonly stdin: AsyncIterable<Buffer | string>; readonly stdout: (text: string) => void }): Promise<number> {
  const chunks: Buffer[] = [];
  try {
    for await (const c of io.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  } catch {
    return 0;
  }
  const out = await relayHook(Buffer.concat(chunks), args[0] ?? "");
  if (out) io.stdout(out);
  return 0;
}
