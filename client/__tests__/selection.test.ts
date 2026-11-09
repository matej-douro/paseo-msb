import test from "node:test";
import assert from "node:assert/strict";
import { rememberChildName, rememberedChildName } from "../selection";

test("detail selection survives a screen remount by sandbox name", () => {
  rememberChildName("paseo-00000000-0000-4000-8000-000000000000");
  assert.equal(
    rememberedChildName(),
    "paseo-00000000-0000-4000-8000-000000000000",
  );

  rememberChildName(null);
  assert.equal(rememberedChildName(), null);
});
