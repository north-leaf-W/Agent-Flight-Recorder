import type { IncomingEvent } from "@afr/protocol";

export const REDACTED = "[REDACTED]";

export type RedactionReport = {
  total: number;
  rules: Record<string, number>;
};

export type RedactionResult<T> = {
  value: T;
  report: RedactionReport;
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "secret"
]);

const STRING_RULES: Array<{
  id: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}> = [
  {
    id: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: `Bearer ${REDACTED}`
  },
  {
    id: "secret-assignment",
    pattern: /\b((?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|PASSWORD|PASSWD|SECRET)\s*=\s*)[^\s,;]+/gi,
    replacement: (_match, prefix) => `${prefix}${REDACTED}`
  },
  {
    id: "provider-token",
    pattern: /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/g,
    replacement: REDACTED
  },
  {
    id: "url-credentials",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replacement: (_match, scheme) => `${scheme}${REDACTED}@`
  }
];

export function redactValue<T>(input: T): RedactionResult<T> {
  const report: RedactionReport = { total: 0, rules: {} };
  const value = visit(input, report) as T;
  return { value, report };
}

export function redactText(input: string): RedactionResult<string> {
  return redactValue(input);
}

export function redactIncomingEvent(event: IncomingEvent): RedactionResult<IncomingEvent> {
  const source: IncomingEvent = {
    ...event,
    payload: { ...event.payload }
  };
  delete source.payload._afrRedaction;
  const result = redactValue(source);
  if (result.report.total > 0) {
    result.value.payload = {
      ...result.value.payload,
      _afrRedaction: result.report
    };
  }
  return result;
}

function visit(value: unknown, report: RedactionReport): unknown {
  if (typeof value === "string") {
    return redactString(value, report);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => visit(item, report));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      output[key] = REDACTED;
      increment(report, "sensitive-field");
    } else {
      output[key] = visit(item, report);
    }
  }
  return output;
}

function redactString(value: string, report: RedactionReport): string {
  let result = value;
  for (const rule of STRING_RULES) {
    result = result.replace(rule.pattern, (...arguments_: string[]) => {
      increment(report, rule.id);
      if (typeof rule.replacement === "string") {
        return rule.replacement;
      }
      const [match, ...groups] = arguments_;
      return rule.replacement(match ?? "", ...groups);
    });
  }
  return result;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function increment(report: RedactionReport, rule: string): void {
  report.total += 1;
  report.rules[rule] = (report.rules[rule] ?? 0) + 1;
}
