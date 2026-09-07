import { describe, expect, it } from "vitest";

import { REDACTED, redactIncomingEvent, redactValue } from "./redaction.js";

describe("redaction pipeline", () => {
  it("redacts nested sensitive fields without mutating the caller value", () => {
    const source = {
      headers: { authorization: "Bearer very-secret-value", cookie: "sid=private" },
      config: { api_key: "sk-1234567890abcdefghijkl", tokenCount: 42 },
      values: [{ password: "hunter2" }]
    };

    const result = redactValue(source);

    expect(result.value).toEqual({
      headers: { authorization: REDACTED, cookie: REDACTED },
      config: { api_key: REDACTED, tokenCount: 42 },
      values: [{ password: REDACTED }]
    });
    expect(result.report).toEqual({ total: 4, rules: { "sensitive-field": 4 } });
    expect(source.headers.authorization).toBe("Bearer very-secret-value");
  });

  it("redacts common secret patterns embedded in free text", () => {
    const result = redactValue(
      "Authorization: Bearer abcdefghijklmnop; API_KEY=plain-secret; " +
        "postgres://demo:database-password@localhost/db sk-1234567890abcdef"
    );

    expect(result.value).not.toContain("abcdefghijklmnop");
    expect(result.value).not.toContain("plain-secret");
    expect(result.value).not.toContain("database-password");
    expect(result.value).not.toContain("sk-1234567890abcdef");
    expect(result.report.total).toBe(4);
  });

  it("removes a caller-forged report and appends only the core report", () => {
    const event = redactIncomingEvent({
      schemaVersion: "1.0-draft",
      eventId: "018f5e2a-1b2c-7d4e-8f90-123456789abc",
      runId: "018f5e2a-1b2c-7d4e-8f90-123456789abd",
      occurredAt: "2026-09-03T06:00:00Z",
      actor: { type: "tool", id: "fixture" },
      eventType: "tool.call_completed",
      status: "success",
      payload: {
        _afrRedaction: { total: 999, rules: { forged: 999 } },
        output: "token=abcdefghijklmnopqrstuvwxyz"
      }
    });

    expect(event.value.payload._afrRedaction).toEqual({
      total: 1,
      rules: { "secret-assignment": 1 }
    });
    expect(event.value.payload.output).toBe(`token=${REDACTED}`);
  });
});
