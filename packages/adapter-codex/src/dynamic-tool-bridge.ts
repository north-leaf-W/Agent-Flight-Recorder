import {
  NetworkGatewayError,
  ReadOnlyNetworkGateway,
  type ReadOnlyNetworkMethod
} from "@afr/core";

import {
  AppServerRequestRejectedError,
  type AppServerDynamicToolCall,
  type AppServerDynamicToolResponse,
  type AppServerDynamicToolSpec
} from "./app-server-supervisor.js";

export const NETWORK_READ_DYNAMIC_TOOL: AppServerDynamicToolSpec = {
  type: "function",
  name: "afr_network_read",
  description: "Read an explicitly allowlisted HTTP(S) resource through the AFR read-only network gateway.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "Absolute HTTP(S) URL on an AFR allowlisted hostname." },
      method: { type: "string", enum: ["GET", "HEAD"], default: "GET" },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Optional safe request headers accepted by the AFR gateway."
      }
    },
    required: ["url"]
  }
};

export type NetworkReadDynamicToolOptions = {
  gateway: ReadOnlyNetworkGateway;
  sessionId: string;
};

export function createNetworkReadDynamicToolHandler(
  options: NetworkReadDynamicToolOptions
): (call: AppServerDynamicToolCall, signal: AbortSignal) => Promise<AppServerDynamicToolResponse> {
  return async (call, signal) => {
    if (call.tool !== NETWORK_READ_DYNAMIC_TOOL.name || call.namespace !== undefined) {
      throw new AppServerRequestRejectedError(
        -32601,
        `AFR does not expose dynamic tool: ${call.tool}`
      );
    }
    const input = parseInput(call.arguments);
    if (signal.aborted) {
      throw new AppServerRequestRejectedError(-32800, "AFR dynamic tool call was cancelled");
    }
    try {
      const result = await options.gateway.request({
        sessionId: options.sessionId,
        url: input.url,
        method: input.method,
        ...(input.headers === undefined ? {} : { headers: input.headers })
      });
      if (signal.aborted) {
        throw new AppServerRequestRejectedError(-32800, "AFR dynamic tool call was cancelled");
      }
      return {
        success: true,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            method: result.method,
            statusCode: result.statusCode,
            finalOrigin: result.finalOrigin,
            responseHash: result.responseHash,
            byteSize: result.byteSize,
            redirectCount: result.redirectCount,
            responseHeaders: result.responseHeaders,
            ...encodeBody(result.body, result.responseHeaders["content-type"])
          })
        }]
      };
    } catch (error) {
      if (error instanceof AppServerRequestRejectedError) throw error;
      const code = error instanceof NetworkGatewayError ? error.code : "gateway_failed";
      return {
        success: false,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({ error: code, message: "AFR read-only network request failed" })
        }]
      };
    }
  };
}

function parseInput(value: unknown): {
  url: string;
  method: ReadOnlyNetworkMethod;
  headers?: Record<string, string>;
} {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new AppServerRequestRejectedError(-32602, "afr_network_read requires a URL string");
  }
  const method = value.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    throw new AppServerRequestRejectedError(-32602, "afr_network_read method must be GET or HEAD");
  }
  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || Object.values(value.headers).some((item) => typeof item !== "string")) {
      throw new AppServerRequestRejectedError(-32602, "afr_network_read headers must be strings");
    }
    headers = value.headers as Record<string, string>;
  }
  return { url: value.url, method, ...(headers === undefined ? {} : { headers }) };
}

function encodeBody(body: Buffer, contentType: string | undefined): Record<string, string> {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const textual = mediaType?.startsWith("text/") === true ||
    mediaType === "application/json" ||
    mediaType?.endsWith("+json") === true ||
    mediaType === "application/xml" ||
    mediaType?.endsWith("+xml") === true;
  if (textual) return { bodyEncoding: "utf8", body: body.toString("utf8") };
  return { bodyEncoding: "base64", body: body.toString("base64") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
