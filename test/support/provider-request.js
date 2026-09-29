import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createClaudeStream } from "../../src/provider.ts";
import { withTimeout } from "./wait.js";

const settlements = new WeakMap();

/** A fresh recorder per invocation: even overlapping streams cannot share it. */
export function createTestClaudeStream(installation, dependencies = {}) {
  return (...request) => {
    let resolveMetrics;
    let records = 0;
    const settled = new Promise((resolve) => { resolveMetrics = resolve; });
    const stream = createClaudeStream(installation, {
      resolveSession: () => ({ cwd: tmpdir() }),
      ...dependencies,
      recordRequestMetrics(metrics) {
        assert.equal(++records, 1, "request metrics recorded more than once");
        dependencies.recordRequestMetrics?.(metrics);
        resolveMetrics({ ...metrics });
      },
    })(...request);
    settlements.set(stream, settled);
    return stream;
  };
}

export async function requestMetrics(request, predicate = () => true) {
  const pending = settlements.get(request);
  assert.ok(pending, "request was not created by the test stream helper");
  const metrics = await withTimeout(pending, "request lifecycle");
  assert.ok(predicate(metrics), `unexpected request metrics: ${JSON.stringify(metrics)}`);
  return metrics;
}

/** Ordinary tests finish cleanup before tearing down their fixtures. Raw stream
 * events and result() remain available to tests of early terminal publication. */
export async function settledRequest(stream) {
  const [result] = await withTimeout(Promise.all([stream.result(), requestMetrics(stream)]), "provider request");
  settlements.set(result, settlements.get(stream));
  return result;
}
