import assert from "node:assert/strict";
import test from "node:test";

import { divide } from "./calculator.js";

test("divide returns the quotient", () => {
  assert.equal(divide(8, 2), 4);
});

test("divide rejects a zero divisor with a clear error", () => {
  assert.throws(() => divide(8, 0), {
    name: "RangeError",
    message: "Divisor must not be zero"
  });
});
