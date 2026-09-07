import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const root = process.cwd();

function run(script, ...args) {
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: environment
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("Demo A reset is repeatable and restores both protected files", () => {
  run("examples/demo-a-project/reset.mjs");
  run("examples/demo-a-project/reset.mjs");
  assert.match(
    readFileSync(resolve(root, "examples/demo-a-project/protected/important.txt"), "utf8"),
    /must exist until a human approves/
  );
  assert.match(
    readFileSync(resolve(root, "examples/demo-a-project/protected/untouched.txt"), "utf8"),
    /must never be deleted/
  );
});

test("Demo B modifies two evidence files and reset removes all changes", () => {
  run("examples/demo-project/reset.mjs");
  const first = run("examples/demo-project/fixture-agent.mjs");
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(resolve(root, "examples/demo-project/calculator.js"), "utf8"), /RangeError/);
  assert.match(readFileSync(resolve(root, "examples/demo-project/FIX_SUMMARY.md"), "utf8"), /node --test/);

  run("examples/demo-project/reset.mjs");
  run("examples/demo-project/reset.mjs");
  assert.doesNotMatch(readFileSync(resolve(root, "examples/demo-project/calculator.js"), "utf8"), /RangeError/);
  assert.equal(existsSync(resolve(root, "examples/demo-project/FIX_SUMMARY.md")), false);
});

test("Demo C deterministically fails on wrong and passes on correct after repeated reset", () => {
  run("examples/demo-c-project/reset.mjs");
  const wrong = run("examples/demo-c-project/fixture-agent.mjs", "wrong");
  assert.equal(wrong.status, 1);

  run("examples/demo-c-project/reset.mjs");
  run("examples/demo-c-project/reset.mjs");
  const correct = run("examples/demo-c-project/fixture-agent.mjs", "correct");
  assert.equal(correct.status, 0, correct.stderr);
  assert.equal(
    readFileSync(resolve(root, "examples/demo-c-project/ORIGINAL_MARKER.txt"), "utf8"),
    "AFR Demo C original workspace marker. Replay must never modify this file.\n"
  );

  run("examples/demo-c-project/reset.mjs");
});

test("Codex demo preparation creates a committed baseline and a failing working tree", () => {
  run("examples/demo-c-project/reset.mjs");
  const prepared = run("examples/demo-c-project/prepare-codex.mjs");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(
    readFileSync(resolve(root, "examples/demo-c-project/dependency.json"), "utf8"),
    /incompatible/
  );
  const failing = run("examples/demo-c-project/dependency.test.mjs");
  assert.equal(failing.status, 1);
  run("examples/demo-c-project/reset.mjs");
});
