import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeMeta, serializeError } from "./logger.js";

test("logger redacts secrets and bearer credentials recursively", () => {
  const result = sanitizeMeta({
    authorization: "Bearer abc.def.ghi",
    nested: { api_key: "private", url: "https://example.test/?token=secret&ok=1" }
  });
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.api_key, "[REDACTED]");
  assert.equal(result.nested.url, "https://example.test/?token=[REDACTED]&ok=1");
});

test("logger safely serializes errors and circular metadata", () => {
  const error = new Error("service unavailable");
  error.code = "UPSTREAM_FAILURE";
  const serialized = serializeError(error);
  assert.equal(serialized.message, "service unavailable");
  assert.equal(serialized.code, "UPSTREAM_FAILURE");
  assert.match(serialized.stack, /service unavailable/);

  const circular = { value: 1 };
  circular.self = circular;
  assert.equal(sanitizeMeta(circular).self, "[CIRCULAR]");
});
