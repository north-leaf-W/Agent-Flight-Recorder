import type { EventEnvelope, IncomingEvent, RunStatus } from "@afr/protocol";

export type RemoteRun = {
  id: string;
  projectPath: string;
  task: string;
  agentId: string;
  status: RunStatus;
  lastSequenceNo: number;
};

export type UploadedBlob = {
  blobRef: string;
  byteSize: number;
  redactionState: "redacted" | "scanned" | "unscanned";
  redactionReport?: { total: number; rules: Record<string, number> };
};

export type RemoteApproval = {
  id: string;
  runId: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired";
  snapshotId?: string;
};

export type RemoteGatewayAction = {
  id: string;
  approvalId?: string;
  status: "waiting_approval" | "executing" | "completed" | "denied" | "failed";
  errorCode?: string;
};

export type RemoteCheckpoint = {
  id: string;
  runId: string;
  sourceEventId?: string;
  workspaceRoot: string;
  createdAt: string;
};

export type RemoteReplay = {
  id: string;
  sourceRunId: string;
  targetRunId: string;
  status: "queued" | "running" | "completed" | "failed";
  worktreePath: string;
  errorCode?: string;
  errorMessage?: string;
  comparison?: unknown;
};

export type RemoteReplayResult = {
  replay: RemoteReplay;
  sourceWorkspaceHashBefore: string;
  sourceWorkspaceHashAfter: string;
};

export interface AfrRunApi {
  createRun(input: { projectPath: string; task: string; agentId: string }): Promise<RemoteRun>;
  appendEvents(runId: string, events: IncomingEvent[]): Promise<EventEnvelope[]>;
  putBlob(content: string, mediaType: string): Promise<UploadedBlob>;
  setStatus(runId: string, status: RunStatus, reason?: string): Promise<RemoteRun>;
  createCheckpoint?(runId: string, sourceEventId?: string): Promise<{ id: string }>;
}

export class AfrApiClient implements AfrRunApi {
  constructor(readonly baseUrl: string, private readonly token: string) {}

  async createRun(input: {
    projectPath: string;
    task: string;
    agentId: string;
  }): Promise<RemoteRun> {
    const response = await this.request<{ run: RemoteRun }>("/runs", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.run;
  }

  async appendEvents(runId: string, events: IncomingEvent[]): Promise<EventEnvelope[]> {
    const response = await this.request<{ events: EventEnvelope[] }>(
      `/runs/${encodeURIComponent(runId)}/events:batch`,
      { method: "POST", body: JSON.stringify({ events }) }
    );
    return response.events;
  }

  async putBlob(content: string, mediaType: string): Promise<UploadedBlob> {
    return this.request<UploadedBlob>("/blobs", {
      method: "POST",
      body: JSON.stringify({
        contentBase64: Buffer.from(content, "utf8").toString("base64"),
        mediaType
      })
    });
  }

  async setStatus(runId: string, status: RunStatus, reason?: string): Promise<RemoteRun> {
    const response = await this.request<{ run: RemoteRun }>(
      `/runs/${encodeURIComponent(runId)}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status, ...(reason === undefined ? {} : { reason }) })
      }
    );
    return response.run;
  }

  async createCheckpoint(runId: string, sourceEventId?: string): Promise<{ id: string }> {
    const response = await this.request<{ checkpoint: { id: string } }>("/checkpoints", {
      method: "POST",
      body: JSON.stringify({ runId, ...(sourceEventId === undefined ? {} : { sourceEventId }) })
    });
    return response.checkpoint;
  }

  async listCheckpoints(runId: string): Promise<RemoteCheckpoint[]> {
    const response = await this.request<{ checkpoints: RemoteCheckpoint[] }>(
      `/runs/${encodeURIComponent(runId)}/checkpoints`,
      { method: "GET" }
    );
    return response.checkpoints;
  }

  async createReplay(input: {
    checkpointId: string;
    command: string[];
    task?: string;
    overrides?: Record<string, string>;
  }): Promise<RemoteReplayResult> {
    return this.request<RemoteReplayResult>("/replays", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async exportRun(runId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/runs/${encodeURIComponent(runId)}/export`, {
      method: "POST",
      body: "{}"
    });
  }

  async requestDelete(input: {
    runId: string;
    path: string;
    reason?: string;
  }): Promise<{ approval: RemoteApproval; action: RemoteGatewayAction }> {
    const response = await this.request<{
      result: { evaluation: { approval: RemoteApproval }; action: RemoteGatewayAction };
    }>("/gateway/files:delete", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return {
      approval: response.result.evaluation.approval,
      action: response.result.action
    };
  }

  async getApproval(approvalId: string): Promise<RemoteApproval> {
    const response = await this.request<{ approval: RemoteApproval }>(
      `/approvals/${encodeURIComponent(approvalId)}`,
      { method: "GET" }
    );
    return response.approval;
  }

  async getGatewayAction(approvalId: string): Promise<RemoteGatewayAction> {
    const response = await this.request<{ action: RemoteGatewayAction }>(
      `/gateway/actions?approvalId=${encodeURIComponent(approvalId)}`,
      { method: "GET" }
    );
    return response.action;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AFR API ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  }
}
