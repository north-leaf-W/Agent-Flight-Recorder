import { describe, expect, it } from "vitest";

import { CodexJsonlDecoder, CodexJsonlLineTooLongError } from "./jsonl-decoder.js";

describe("CodexJsonlDecoder", () => {
  it("reassembles split lines and UTF-8 characters", () => {
    const decoder = new CodexJsonlDecoder();
    const encoded = Buffer.from('{"text":"你好"}\n{"type":"done"}', "utf8");
    const split = encoded.indexOf(Buffer.from("好")) + 1;

    expect(decoder.push(encoded.subarray(0, split))).toEqual([]);
    expect(decoder.push(encoded.subarray(split))).toEqual(['{"text":"你好"}']);
    expect(decoder.finish()).toEqual(['{"type":"done"}']);
  });

  it("accepts CRLF and ignores no data", () => {
    const decoder = new CodexJsonlDecoder();
    expect(decoder.push("one\r\ntwo\n")).toEqual(["one", "two"]);
    expect(decoder.finish()).toEqual([]);
  });

  it("rejects a line larger than the configured limit", () => {
    const decoder = new CodexJsonlDecoder(8);
    expect(() => decoder.push("123456789")).toThrow(CodexJsonlLineTooLongError);
  });
});
