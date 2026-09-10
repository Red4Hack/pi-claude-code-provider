import { createServer } from "node:http";

/**
 * Stand in for a local llama.cpp server: the same OpenAI-compatible surface the
 * Claude Code stand-in talks to, with no model and no network. Tests decide the
 * reply, so a case can pin behaviour a real model could only be coaxed into.
 */
export async function startLocalModelServer(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url, body });
      const payload = typeof reply === "function" ? reply(body, requests.length) : reply;
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

/** Build one OpenAI-compatible completion payload. */
export function completionPayload({ content = "", reasoning, toolCalls = [], finishReason = "stop", usage } = {}) {
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
    usage: usage ?? { prompt_tokens: 41, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 11 } },
  };
}
