import fs from "node:fs";

/**
 * Every complete line of a JSONL file the code under test is still appending to (`JSON + "\n"` per record): whatever
 * follows the last newline may be a line still being written, so it is skipped now and seen on a later poll. A missing
 * file is no lines.
 */
export function completeJsonl<T = Record<string, unknown>>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.pop();
  return lines.filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as T);
}
