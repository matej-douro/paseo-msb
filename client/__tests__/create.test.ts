import test from "node:test";
import assert from "node:assert/strict";
import {
  canCreate,
  createRequestId,
  newCreateAttempt,
  toggleCredential,
} from "../create";
import type { CredentialName } from "../types";

const anthropic: CredentialName = "ANTHROPIC_API_KEY";
const github: CredentialName = "GH_TOKEN";
const available: CredentialName[] = [anthropic, github];

test("request IDs are UUID v4 strings and one attempt creates one ID", () => {
  const first = createRequestId();
  const second = createRequestId();
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  assert.match(first, uuidPattern);
  assert.match(second, uuidPattern);
  assert.notEqual(first, second);

  let generated = 0;
  const attempt = newCreateAttempt(() => {
    generated += 1;
    return first;
  });
  assert.equal(attempt.requestId, first);
  assert.equal(generated, 1);

  const retry = { ...attempt };
  assert.equal(retry.requestId, attempt.requestId);
  assert.equal(generated, 1);
});

test("credential selection keeps one logical attempt usable after a failure", () => {
  const attempt = newCreateAttempt(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const selected = toggleCredential([], anthropic, available);
  const failed = { attempt, selected };

  assert.equal(failed.attempt.requestId, attempt.requestId);
  assert.deepEqual(failed.selected, [anthropic]);
});

test("credential selection only accepts available names and needs at least one", () => {
  assert.deepEqual(toggleCredential([], anthropic, available), [anthropic]);
  assert.deepEqual(toggleCredential([anthropic], anthropic, available), []);
  assert.deepEqual(toggleCredential([], "OPENAI_API_KEY", available), []);
  assert.equal(canCreate([], available), false);
  assert.equal(canCreate([anthropic], available), true);
  assert.equal(canCreate([anthropic, github], available), true);
  assert.equal(canCreate(["OPENAI_API_KEY"], available), false);
});
