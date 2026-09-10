import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalClaudeExecutable } from "../support/local-claude.js";
import { createClaudeStream } from "../../src/provider.ts";
import { inspectClaudeInstallation } from "../../src/auth.ts";

const model = {
  id: "sonnet",
  name: "Sonnet",
  api: "pi-claude-code-provider-headless",
  provider: "pi-claude-code-provider",
  baseUrl: "pi-claude-code-provider://local",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};
const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
const toolContext = {
  ...context,
  tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};

/** Stand in for llama.cpp: same OpenAI-compatible surface, no model and no network. */
async function stubModelServer(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url, body });
      const payload = typeof reply === "function" ? reply(body) : reply;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function completion({ content = "", reasoning, toolCalls = [], finishReason = "stop" } = {}) {
  return {
    choices: [{
      finish_reason: finishReason,
      message: {
        role: "assistant",
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: { prompt_tokens: 41, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 11 } },
  };
}

async function withLocalClaude(reply, run) {
  const directory = await mkdtemp(join(tmpdir(), "local-claude-"));
  const server = await stubModelServer(reply);
  try {
    const executable = await createLocalClaudeExecutable(directory, { baseUrl: server.baseUrl, model: "local-test-model" });
    await run({ executable, server, directory });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("the local Claude stand-in satisfies the provider's preflight surface", async () => {
  await withLocalClaude(completion({ content: "unused" }), async ({ executable }) => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
      // The same preflight production runs: version, eligible subscription auth,
      // and the captured help every required headless flag is checked against.
      const installation = await inspectClaudeInstallation();
      assert.equal(installation.subscriptionType, "pro");
      assert.match(installation.version, /^\d+\.\d+\.\d+$/);
    } finally {
      if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
      else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
    }
  });
});

test("a local text turn completes through the provider's protocol validation", async () => {
  await withLocalClaude(completion({ content: "LOCAL-OK", reasoning: "brief plan" }), async ({ executable, server }) => {
    const result = await createClaudeStream({ executable, version: "2.1.261", subscriptionType: "pro" })(
      model,
      context,
      { reasoning: "medium", maxTokens: 256 },
    ).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content.find((block) => block.type === "text")?.text, "LOCAL-OK");
    assert.equal(result.content.find((block) => block.type === "thinking")?.thinking, "brief plan");
    assert.equal(result.usage.input, 41);
    assert.equal(result.usage.cacheRead, 11);
    assert.equal(result.responseModel, "local-test-model");
    // Pi budgets the answer and reasoning is added on top of it, so the local
    // model is offered the same ceiling a real request would receive.
    assert.equal(server.requests[0].body.max_tokens, 256 + 8_192);
    assert.equal(server.requests[0].body.tools, undefined);
  });
});

test("a local tool proposal round-trips through the real proposal bridge", async () => {
  const reply = completion({
    toolCalls: [{ id: "call_local_1", function: { name: "read", arguments: '{"path":"README.md"}' } }],
  });
  await withLocalClaude(reply, async ({ executable, server }) => {
    const result = await createClaudeStream({ executable, version: "2.1.261", subscriptionType: "pro" })(
      model,
      toolContext,
      { reasoning: "medium" },
    ).result();
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    const call = result.content.find((block) => block.type === "toolCall");
    assert.equal(call?.name, "read");
    assert.deepEqual(call?.arguments, { path: "README.md" });
    // The stand-in reached the tool catalog by completing a real initialize and
    // tools/list handshake against the proposal bridge, which is also what
    // writes the readiness marker the provider waits on.
    assert.deepEqual(server.requests[0].body.tools?.map((tool) => tool.function.name), ["read"]);
  });
});

test("a local turn that hits its output ceiling reports a length stop", async () => {
  await withLocalClaude(completion({ content: "cut off", finishReason: "length" }), async ({ executable }) => {
    const result = await createClaudeStream({ executable, version: "2.1.261", subscriptionType: "pro" })(
      model,
      context,
      { reasoning: "low", maxTokens: 32 },
    ).result();
    assert.equal(result.stopReason, "length", result.errorMessage);
  });
});
