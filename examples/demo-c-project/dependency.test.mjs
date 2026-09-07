import assert from "node:assert/strict";
import test from "node:test";

import dependency from "./dependency.json" with { type: "json" };

test("the selected math engine is compatible", () => {
  assert.equal(dependency["math-engine"], "compatible");
});
