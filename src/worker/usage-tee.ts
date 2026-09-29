// Reads token usage from a copy of the response bytes. The client always gets the original bytes; this side branch
// decompresses (gzip/br/deflate, the codings the proxy offers upstream) and parses. Anything it cannot read ends
// in `usage: null` with a reason, never in an error on the response path.
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { UsageParser, usageFormat, type Stop, type Usage } from "../wire/anthropic.js";

export interface UsageOutcome {
  readonly usage: Usage | null;
  /** Why usage is null: "encoding:<name>", "content_type", "decode_error", "no_usage", "incomplete". */
  readonly unknownReason: string | null;
  readonly stop: Stop | null;
}

export class UsageTee {
  readonly #parser: UsageParser | null;
  readonly #decoder = new StringDecoder("utf8");
  readonly #inflate: zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null = null;
  #failed: string | null = null;
  readonly #done: Promise<void>;

  constructor(contentType: string | undefined, contentEncoding: string | undefined) {
    const format = usageFormat(contentType);
    this.#parser = format ? new UsageParser(format) : null;
    if (!this.#parser) this.#failed = "content_type";
    const enc = (contentEncoding ?? "identity").trim().toLowerCase();
    if (this.#parser && enc !== "identity" && enc !== "") {
      if (enc === "gzip" || enc === "x-gzip") this.#inflate = zlib.createGunzip();
      else if (enc === "br") this.#inflate = zlib.createBrotliDecompress();
      else if (enc === "deflate") this.#inflate = zlib.createInflate();
      else this.#failed = `encoding:${enc}`;
    }
    const inflate = this.#inflate;
    this.#done = inflate
      ? new Promise<void>((resolve) => {
          inflate.on("data", (c: Buffer) => this.#text(c));
          inflate.on("end", resolve);
          inflate.on("error", () => {
            this.#failed = "decode_error";
            resolve();
          });
        })
      : Promise.resolve();
  }

  #text(chunk: Buffer): void {
    try {
      this.#parser?.push(this.#decoder.write(chunk));
    } catch {
      this.#failed = "decode_error";
    }
  }

  write(chunk: Buffer): void {
    if (this.#failed !== null) return;
    if (this.#inflate) this.#inflate.write(chunk);
    else this.#text(chunk);
  }

  /** The stop reason parsed so far; synchronous, so an uncompressed stream shows it as soon as its bytes passed. */
  get stop(): Stop | null {
    return this.#parser?.stop() ?? null;
  }

  /** `complete` = the upstream response ended normally. */
  async end(complete: boolean): Promise<UsageOutcome> {
    if (this.#inflate) {
      if (complete && this.#failed === null) this.#inflate.end();
      else this.#inflate.destroy();
      if (complete && this.#failed === null) await this.#done;
    }
    if (this.#failed !== null) return { usage: null, unknownReason: this.#failed, stop: null };
    this.#parser?.push(this.#decoder.end());
    const usage = this.#parser?.result() ?? null;
    const stop = this.#parser?.stop() ?? null;
    if (usage === null) return { usage: null, unknownReason: complete ? "no_usage" : "incomplete", stop };
    return { usage, unknownReason: null, stop };
  }
}
