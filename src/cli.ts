import { doctorCommand, versionCommand } from "./commands.js";
import { launch, realLaunchIO } from "./launcher/launch.js";
import { hookRelayCommand } from "./outcome/hook-relay.js";
import { reportCommand } from "./report/index.js";
import { shareCommand } from "./report/share.js";
import { statuslineCommand } from "./statusline.js";

/** Subcommands reflex owns. Everything else, including every flag, goes to claude untouched. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(["doctor", "hook-relay", "report", "share", "statusline", "version"]);

export type Route = { readonly kind: "claude"; readonly args: string[] } | { readonly kind: "reflex"; readonly command: string; readonly args: string[] };

/** `reflex -- <args>` is the explicit escape hatch: forward <args> even if they start with a reserved word. */
export function route(argv: readonly string[]): Route {
  const [first, ...rest] = argv;
  if (first === "--") return { kind: "claude", args: rest };
  if (first !== undefined && RESERVED_COMMANDS.has(first)) return { kind: "reflex", command: first, args: rest };
  return { kind: "claude", args: [...argv] };
}

export async function main(argv: readonly string[]): Promise<number> {
  const r = route(argv);
  if (r.kind === "claude") return launch(r.args, realLaunchIO());
  const io = { ...realLaunchIO(), stdout: (t: string) => void process.stdout.write(t) };
  switch (r.command) {
    case "version":
      return versionCommand(io);
    case "doctor":
      return doctorCommand(io);
    case "report":
      return reportCommand(r.args, io);
    case "share":
      return shareCommand(r.args, io);
    case "statusline":
      return statuslineCommand({ stdout: io.stdout, env: io.env });
    case "hook-relay":
      return hookRelayCommand(r.args, { stdin: process.stdin, stdout: io.stdout });
    default:
      io.stderr(`reflex ${r.command}: not implemented yet\n`);
      return 2;
  }
}

// `main` is the only entry point; bin/reflex.js calls it.
export const run = (): void => {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`reflex: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
};
