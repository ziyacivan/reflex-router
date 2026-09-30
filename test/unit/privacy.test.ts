import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { head, headTail, tail } from "../../src/privacy/budget.js";
import { redact } from "../../src/privacy/redact.js";
import { buildState } from "../../src/privacy/state.js";

describe("redact", () => {
  const secrets: [string, string][] = [
    ["typesafe_key", "use apikey_abcdef1234567890 here"],
    ["anthropic_key", "key sk-ant-api03-abcdefghijklmnop"],
    ["typellm_key", "key tl-sk-abcdefghijklmnop0123 here"],
    ["api_key", "OPENAI sk-abcdefghijklmnopqrstuvwx"],
    ["aws_key", "AKIAABCDEFGHIJKLMNOP"],
    ["github_token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github_token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
    ["slack_token", "xoxb-1234567890-abcdefghij"],
    ["google_key", "AIzaSyA-abcdefghijklmnopqrstuvwxyz12345"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["bearer", "curl -H 'x: Bearer abcdefghijklmnop'"],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"],
  ];
  for (const [kind, text] of secrets) {
    it(`redacts ${kind}`, () => {
      const out = redact(text);
      assert.match(out, new RegExp(`\\[REDACTED:(${kind}|auth_header|bearer)\\]`));
      assert.doesNotMatch(out, /abcdefghijklmnop|MIIEowIBAAKCAQEA|dozjgNryP4J3|AKIAABCDEF/);
    });
  }

  it("redacts the value of Authorization headers, keeping the name", () => {
    assert.equal(redact("Authorization: Bearer abc.def.ghi"), "Authorization: [REDACTED:auth_header]");
  });

  it("redacts every .env-style line's value, multi-line, keeping the variable name", () => {
    const out = redact("A=1\nexport DATABASE_URL=postgres://u:p@h/db\nnot an env line = x\n  TOKEN = abc");
    assert.equal(out, "A=[REDACTED:env_value]\nexport DATABASE_URL=[REDACTED:env_value]\nnot an env line = x\n  TOKEN = [REDACTED:env_value]");
  });

  it("replaces home-directory prefixes (they carry the OS username) with ~", () => {
    assert.equal(redact("see /Users/alice/src/app.ts and /home/bob/x"), "see ~/src/app.ts and ~/x");
    assert.equal(redact("C:\\Users\\carol\\repo"), "~\\repo");
  });

  it("replaces the home prefix of a bare path, keeping the rest of it verbatim", () => {
    assert.equal(redact("/Users/testuser/projects/x/"), "~/projects/x/");
  });

  it("leaves ordinary code and prose alone (false-positive corpus)", () => {
    const corpus = [
      "const skipped = items.filter((x) => x.sk);",
      "Refactor the auth module; see the task-list in docs/plan.md",
      "run `npm test` and fix the failing sk-test case",
      "The eyJ prefix is how base64 JSON starts.",
      "if (a == b) { return c = d; }",
      "Rename getUserById to findUser across src/",
    ];
    for (const t of corpus) assert.equal(redact(t), t, t);
  });
});

describe("budget", () => {
  it("head+tail keeps both ends and never exceeds the limit (code points)", () => {
    const t = "A".repeat(50) + "MIDDLE" + "Z".repeat(50);
    const out = headTail(t, 40);
    assert.ok(Array.from(out).length <= 40);
    assert.ok(out.startsWith("AAAA") && out.endsWith("ZZZZ"));
    assert.equal(headTail("short", 40), "short");
  });

  it("never splits a surrogate pair", () => {
    const t = "😀".repeat(100);
    for (const f of [(s: string) => headTail(s, 17), (s: string) => tail(s, 17), (s: string) => head(s, 17)]) {
      const out = f(t);
      assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    assert.equal(Array.from(tail(t, 17)).length, 17);
  });
});

describe("buildState: the only thing a backend sees", () => {
  const limits = { maxUserChars: 100, maxAssistantChars: 20 };

  it("sends exactly task, previous_assistant_reply and context{requesting_tier,is_subagent} for the main chat", () => {
    const { state, sent } = buildState({ kind: "main", task: "fix it", previousAssistantText: "I changed the file. Anything else?", requestedModel: "claude-sonnet-5" }, limits);
    assert.deepEqual(Object.keys(state).sort(), ["context", "previous_assistant_reply", "task"]);
    assert.deepEqual(Object.keys(state.context).sort(), ["is_subagent", "requesting_tier"]);
    assert.deepEqual(state.context, { requesting_tier: "sonnet", is_subagent: false });
    assert.equal(state.previous_assistant_reply, "file. Anything else?", "assistant text is cut to its last 20 characters");
    assert.deepEqual(sent.keys, ["task", "previous_assistant_reply", "context"]);
  });

  it("a subagent never sends a previous reply", () => {
    const { state } = buildState({ kind: "subagent", task: "list files", previousAssistantText: "x", requestedModel: "claude-opus-5" }, limits);
    assert.deepEqual(Object.keys(state).sort(), ["context", "task"]);
    assert.equal(state.context.is_subagent, true);
  });

  it("truncates before redacting, and redacts what is sent", () => {
    const { state } = buildState({ kind: "subagent", task: "deploy with apikey_abcdefghijkl0123 now", previousAssistantText: null, requestedModel: null }, limits);
    assert.match(state.task, /\[REDACTED:typesafe_key\]/);
    assert.equal(state.context.requesting_tier, "unknown");
  });
});
