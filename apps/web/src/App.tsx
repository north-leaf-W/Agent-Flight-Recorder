import { useEffect, useMemo, useState } from "react";

type Run = {
  id: string;
  parentRunId?: string;
  forkedFromEventId?: string;
  projectPath: string;
  task: string;
  agentId: string;
  status: string;
  lastSequenceNo: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  eventCount: number;
  commandCount: number;
  fileChangeCount: number;
  gapCount: number;
  highRiskCount: number;
  pendingApprovalCount: number;
  validationStatus: "passed" | "failed" | "unverified";
};

type RunFilter = "all" | "failed" | "waiting" | "high-risk" | "unverified" | "incomplete";
type EventFilter = "all" | "commands" | "files" | "risk" | "errors";

type Checkpoint = {
  id: string;
  runId: string;
  sourceEventId?: string;
  eventId: string;
  workspaceRoot: string;
  baseCommit: string;
  untrackedCount: number;
  totalBytes: number;
  createdAt: string;
};

type RunComparisonSide = {
  runId: string;
  status: string;
  durationMs?: number;
  toolCallCount: number;
  approvalCount: number;
  changedFiles: string[];
  commands: Array<{ argv: string[]; exitCode: number | null; status: string }>;
  simulatedActionCount: number;
  liveActionCount: number;
};

type Replay = {
  id: string;
  checkpointId: string;
  sourceRunId: string;
  sourceEventId?: string;
  targetRunId: string;
  mode: "isolated-live";
  status: "queued" | "running" | "completed" | "failed";
  worktreePath: string;
  command: string[];
  overrides: Record<string, string>;
  comparison?: {
    source: RunComparisonSide;
    target: RunComparisonSide;
    delta: {
      statusChanged: boolean;
      durationMs?: number;
      toolCallCount: number;
      approvalCount: number;
      filesOnlyInSource: string[];
      filesOnlyInTarget: string[];
      filesInBoth: string[];
      testOutcomeChanged: boolean;
    };
  };
  errorCode?: string;
  errorMessage?: string;
};

type Event = {
  eventId: string;
  sequenceNo: number;
  occurredAt: string;
  recordedAt: string;
  actor: { type: string; id: string };
  eventType: string;
  status: string;
  payload: Record<string, unknown>;
  contentHash: string;
  previousEventHash?: string;
};

type Meta = {
  version: string;
  dataDir: string;
  support: { operatingSystem: string; agent: string; coverage: string };
  startup: {
    checkedAt: string;
    quickCheck: "ok";
    removedTemporaryBlobs: number;
    verifiedRuns: number;
    interruptedProviderSessions: number;
    incompleteHostedWorkspaces: number;
    cleanedHostedWorkspaces: number;
    hostedWorkspaceCleanupFailures: number;
    schemaVersion: string;
    appliedMigrations: string[];
    backupPath?: string;
  };
};

type Approval = {
  id: string;
  runId: string;
  actionDigest: string;
  actionContext: {
    actor: { id: string; type: string };
    tool: string;
    action: string;
    argv?: string[];
    cwd?: string;
    targets: Array<{ type: string; canonicalId: string }>;
    environment: string;
    recoverability: string;
    estimatedImpact?: Record<string, number>;
  };
  status: "pending" | "approved" | "consumed" | "denied" | "expired";
  riskLevel: string;
  ruleId: string;
  reasonCodes: string[];
  requestReason?: string;
  decidedBy?: string;
  decisionReason?: string;
  snapshotId?: string;
  requestedAt: string;
  requestExpiresAt: string;
};

type ProviderCapability = {
  state: "supported" | "unsupported" | "degraded";
  source: string;
  version: string;
  detail?: string;
};

type ProviderSession = {
  id: string;
  provider: string;
  adapterVersion: string;
  runtimeVersion: string;
  protocolVersion: string;
  externalSessionId?: string;
  mode: "hosted-observed" | "hosted-governed";
  capabilities: Record<string, ProviderCapability>;
  status: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

type RunCoverage = {
  providerEventCount: number;
  normalizedEventCount: number;
  gapCount: number;
  unknownEventCount: number;
  invalidEventCount: number;
  coveragePercent: number;
  coverageLevel: "L0" | "L1" | "L2" | "L3";
  summary: {
    gapReasons: Record<string, number>;
    workspaceEvidence: "verified" | "pending" | "failed" | "missing";
  };
};

type HostedWorkspace = {
  id: string;
  status: string;
  worktreePath: string;
  baseCommit: string;
  changedPaths: string[];
  diffBlobHash?: string;
  lastErrorMessage?: string;
};

type PatchPromotion = {
  id: string;
  status: string;
  selectedPaths: string[];
  planHash: string;
  errorMessage?: string;
};

type ProviderActionRequest = {
  id: string;
  providerMethod: string;
  status: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  actionContext?: {
    tool: string;
    action: string;
    argv?: string[];
    targets: Array<{ type: string; canonicalId: string }>;
  };
  decisionReason?: string;
};

type ProviderEvent = {
  id: string;
  arrivalSequence: number;
  providerMethod: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  parseStatus: "mapped" | "ignored" | "gap" | "invalid";
  gapReason?: string;
  receivedAt: string;
};

type NetworkMediation = {
  id: string;
  sequenceNo: number;
  source: string;
  operation: string;
  decision: string;
  createdAt: string;
};

type HostedSummary = {
  hosted: boolean;
  session: ProviderSession | null;
  workspace: HostedWorkspace | null;
  coverage: RunCoverage;
  promotions: PatchPromotion[];
  actionRequests: ProviderActionRequest[];
  providerEvents: ProviderEvent[];
  networkEvidenceCount: number;
  networkMediation: NetworkMediation[];
  lifecycle: HostedLifecycle;
  eventChainValid: boolean;
};

type HostedLifecycle = {
  state: "starting" | "running" | "idle" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted" | "unavailable";
  active: boolean;
  canCancel: boolean;
  canContinue: boolean;
  canFinish: boolean;
  canPromote: boolean;
  currentTurnId?: string;
  processId?: number;
  lastError?: string;
};

type HostedPreflight = {
  ready: boolean;
  mode: "hosted-observed";
  runtimeVersion?: string;
  projectPath?: string;
  repositoryRoot?: string;
  checks: Record<string, "passed" | "failed" | "not-checked">;
  reasons: string[];
  constraints: {
    sandboxes: Array<"read-only" | "workspace-write">;
    providerEgressAllowlistCount: number;
    networkReadAllowlistCount: number;
    maximumTimeoutMs: number;
    maximumProviderLineBytes: number;
    maximumProviderStdoutBytes: number;
    maximumProviderMessages: number;
    maximumWorkspaceFiles: number;
    maximumWorkspaceFileBytes: number;
    maximumWorkspaceTotalBytes: number;
    maximumDiffBytes: number;
  };
};

type HostedDiff = {
  workspaceId: string;
  changedPaths: string[];
  diff: string;
  diffBlobHash: string | null;
  redactionState: string;
};

type PromotionPlan = {
  schemaVersion: string;
  workspaceId: string;
  runId: string;
  selectedPaths: string[];
  sourceFingerprintBefore: string;
  worktreeFingerprintBefore: string;
  entries: Array<{
    path: string;
    before?: { type: string; size: number; contentHash: string; binary: boolean };
    after?: { type: string; size: number; contentHash: string; binary: boolean };
  }>;
  createdAt: string;
};

type PromotionReview = {
  ready: boolean;
  baseline: "finalized-change-set" | "immutable-plan";
  sourceDrifted: boolean;
  worktreeDrifted: boolean;
  changedPaths: string[];
  sourceFingerprint: string;
  worktreeFingerprint: string;
  planHash: string | null;
};

const RUN_FILTERS: Array<{ id: RunFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "failed", label: "失败" },
  { id: "waiting", label: "待审批" },
  { id: "high-risk", label: "高风险" },
  { id: "unverified", label: "未验证" },
  { id: "incomplete", label: "采集有限" }
];

const EVENT_FILTERS: Array<{ id: EventFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "commands", label: "命令" },
  { id: "files", label: "文件" },
  { id: "risk", label: "风险" },
  { id: "errors", label: "异常" }
];

export function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [replays, setReplays] = useState<Replay[]>([]);
  const [hostedSummary, setHostedSummary] = useState<HostedSummary>();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(() => runIdFromPath());
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [meta, setMeta] = useState<Meta>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");

  useEffect(() => {
    void loadMeta().then(setMeta).catch((reason: unknown) => setError(messageOf(reason)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextRuns = await loadRuns();
        if (!cancelled) {
          setRuns(nextRuns);
          setSelectedRunId((current) =>
            current !== undefined && nextRuns.some((run) => run.id === current)
              ? current
              : nextRuns[0]?.id
          );
          setError(undefined);
          setLoading(false);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(messageOf(reason));
          setLoading(false);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (selectedRunId === undefined) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    let source: EventSource | undefined;
    const start = async () => {
      try {
        const nextEvents = await loadEvents(selectedRunId);
        if (!cancelled) {
          setEvents(nextEvents);
          setSelectedEventId((current) =>
            nextEvents.some((event) => event.eventId === current)
              ? current
              : nextEvents.at(-1)?.eventId
          );
          const afterSequenceNo = nextEvents.at(-1)?.sequenceNo ?? 0;
          source = new EventSource(
            `/api/v1/runs/${selectedRunId}/stream?afterSequenceNo=${afterSequenceNo}`
          );
          source.addEventListener("afr-event", (message) => {
            const event = JSON.parse((message as MessageEvent<string>).data) as Event;
            setEvents((current) =>
              current.some((item) => item.eventId === event.eventId) ? current : [...current, event]
            );
            setSelectedEventId((current) => current ?? event.eventId);
          });
        }
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
    };
    void start();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === undefined) {
      setHostedSummary(undefined);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await loadHostedSummary(selectedRunId);
        if (!cancelled) setHostedSummary(next);
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === undefined) {
      setCheckpoints([]);
      setReplays([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const [nextCheckpoints, nextReplays] = await Promise.all([
          loadCheckpoints(selectedRunId),
          loadReplays(selectedRunId)
        ]);
        if (!cancelled) {
          setCheckpoints(nextCheckpoints);
          setReplays(nextReplays);
        }
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId === undefined) {
      setApprovals([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await loadApprovals(selectedRunId);
        if (!cancelled) setApprovals(next);
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedEvent = events.find((event) => event.eventId === selectedEventId);
  const gaps = useMemo(
    () => events.filter((event) => event.eventType === "collection.gap_detected"),
    [events]
  );
  const adapterCapabilityEvent = useMemo(
    () => events.find(
      (event) => event.eventType === "artifact.created" &&
        event.payload.kind === "agent_adapter_capabilities"
    ),
    [events]
  );
  const firstError = useMemo(() => events.find((event) => event.status === "error"), [events]);
  const filteredRuns = useMemo(
    () => runs.filter((run) => matchesRunFilter(run, runFilter)),
    [runs, runFilter]
  );
  const filteredEvents = useMemo(
    () => events.filter((event) => matchesEventFilter(event, eventFilter)),
    [events, eventFilter]
  );

  function selectRun(id: string) {
    setSelectedRunId(id);
    setSelectedEventId(undefined);
    setEventFilter("all");
    window.history.replaceState({}, "", `/runs/${id}`);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AFR</span>
          <div>
            <h1>Agent Flight Recorder</h1>
            <p>本地运行证据、审批与隔离回放 · Hosted 控制台</p>
          </div>
        </div>
        <div className="runtime">
          <span className="live-dot" />
          <span>本地服务</span>
          <code>{meta?.version ?? "连接中"}</code>
        </div>
      </header>

      {error && <div className="error-banner">无法读取 AFR：{error}</div>}
      {meta && (
        <section className="startup-report" aria-label="启动恢复报告">
          <strong>数据库健康</strong>
          <span>SQLite {meta.startup.quickCheck}</span>
          <span>校验 {meta.startup.verifiedRuns} 条 Run</span>
          <span>Schema {meta.startup.schemaVersion}</span>
          <span>
            {meta.startup.appliedMigrations.length === 0
              ? "无需迁移"
              : `已迁移 ${meta.startup.appliedMigrations.length} 项`}
          </span>
          {meta.startup.removedTemporaryBlobs > 0 && (
            <span>清理 {meta.startup.removedTemporaryBlobs} 个临时 Blob</span>
          )}
          {meta.startup.interruptedProviderSessions > 0 && (
            <span>回收 {meta.startup.interruptedProviderSessions} 个中断 Provider Session</span>
          )}
          {meta.startup.cleanedHostedWorkspaces > 0 && (
            <span>清理 {meta.startup.cleanedHostedWorkspaces} 个未完成 worktree</span>
          )}
          {meta.startup.hostedWorkspaceCleanupFailures > 0 && (
            <span>有 {meta.startup.hostedWorkspaceCleanupFailures} 个 worktree 待人工回收</span>
          )}
          {meta.startup.backupPath && <code title={meta.startup.backupPath}>升级前备份已保留</code>}
        </section>
      )}
      <section className="coverage-banner">
        <strong>
          {gaps.length > 0
            ? "采集范围有限"
            : hostedSummary?.hosted
              ? `Hosted ${hostedSummary.coverage.coverageLevel}`
            : adapterCapabilityEvent === undefined
              ? "等待采集声明"
              : "适配器已接入"}
        </strong>
        <span>
          {gaps.length > 0
            ? String(gaps[0]?.payload.reason)
            : hostedSummary?.hosted
              ? `${hostedSummary.session?.mode ?? "hosted"} · ${hostedSummary.coverage.coveragePercent.toFixed(1)}% Provider events · ${hostedSummary.networkEvidenceCount} network records`
            : adapterCapabilityEvent === undefined
              ? meta?.support.coverage ?? "正在读取当前适配器能力"
              : adapterSummary(adapterCapabilityEvent)}
        </span>
      </section>

      <section className="workspace">
        <aside className="runs-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">RUNS</span>
              <h2>运行记录</h2>
            </div>
            <span className="count">{runs.length}</span>
          </div>
          <HostedLaunchCard
            suggestedProjectPath={selectedRun?.projectPath}
            onCreated={async (run) => {
              const nextRuns = await loadRuns();
              setRuns(nextRuns);
              selectRun(run.id);
            }}
            onError={setError}
          />
          <div className="filter-strip run-filters" aria-label="Run 筛选">
            {RUN_FILTERS.map((filter) => (
              <button
                className={runFilter === filter.id ? "active" : ""}
                key={filter.id}
                onClick={() => setRunFilter(filter.id)}
              >
                {filter.label}
                <span>{runs.filter((run) => matchesRunFilter(run, filter.id)).length}</span>
              </button>
            ))}
          </div>
          {loading ? (
            <div className="empty state-card"><span className="state-spinner" />正在加载本地记录…</div>
          ) : runs.length === 0 ? (
            <div className="empty state-card">
              <strong>还没有 Run</strong>
              <span>使用 afr exec 执行一个命令后，这里会出现真实记录。</span>
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="empty state-card">
              <strong>没有符合条件的 Run</strong>
              <span>换一个筛选条件，或继续运行固定 Demo。</span>
              <button className="text-button" onClick={() => setRunFilter("all")}>显示全部</button>
            </div>
          ) : (
            <div className="run-list">
              {filteredRuns.map((run) => (
                <button
                  className={`run-card ${run.id === selectedRunId ? "selected" : ""}`}
                  key={run.id}
                  onClick={() => selectRun(run.id)}
                >
                  <div className="run-card-top">
                    <Status status={run.status} />
                    <time>{formatTime(run.startedAt ?? run.createdAt)}</time>
                  </div>
                  <strong>{run.task}</strong>
                  <span className="run-project">{projectName(run.projectPath)} · {run.agentId}</span>
                  <div className="run-stats">
                    <span>{run.commandCount} 命令</span>
                    <span>{run.fileChangeCount} 文件</span>
                    {run.highRiskCount > 0 && <span className="risk-stat">{run.highRiskCount} 高风险</span>}
                    {run.gapCount > 0 && <span className="gap-stat">采集有限</span>}
                  </div>
                  <code>{shortId(run.id)}</code>
                </button>
              ))}
            </div>
          )}
          <div className="data-boundary">
            <span>数据目录</span>
            <code title={meta?.dataDir}>{meta?.dataDir ?? "—"}</code>
          </div>
        </aside>

        <section className="timeline-panel">
          <div className="panel-heading detail-heading">
            <div>
              <span className="eyebrow">TIMELINE</span>
              <h2>{selectedRun?.task ?? "选择一条运行"}</h2>
            </div>
            {selectedRun && <Status status={selectedRun.status} />}
          </div>
          {selectedRun && (
            <div className="run-meta">
              <Validation status={selectedRun.validationStatus} />
              <span>{selectedRun.agentId}</span>
              <code>{selectedRun.projectPath}</code>
              <span>{formatDuration(selectedRun)} · {events.length} events</span>
            </div>
          )}
          {adapterCapabilityEvent && <AdapterCapabilityCard event={adapterCapabilityEvent} />}
          {selectedRun && hostedSummary?.hosted && (
            <HostedControlCard
              runId={selectedRun.id}
              summary={hostedSummary}
              onChanged={async () => {
                const [nextSummary, nextApprovals, nextRuns] = await Promise.all([
                  loadHostedSummary(selectedRun.id),
                  loadApprovals(selectedRun.id),
                  loadRuns()
                ]);
                setHostedSummary(nextSummary);
                setApprovals(nextApprovals);
                setRuns(nextRuns);
              }}
              onError={setError}
            />
          )}
          {firstError && (
            <button className="anomaly-banner" onClick={() => setSelectedEventId(firstError.eventId)}>
              <strong>首个异常 #{firstError.sequenceNo}</strong>
              <span>{eventTitle(firstError)}</span>
              <code>{firstError.eventType}</code>
            </button>
          )}
          {selectedRun && (
            <ReplayLab
              key={selectedRun.id}
              run={selectedRun}
              selectedEventId={selectedEventId}
              checkpoints={checkpoints}
              replays={replays}
              onCheckpointsChanged={setCheckpoints}
              onReplaysChanged={setReplays}
              onRunsChanged={setRuns}
              onError={setError}
            />
          )}
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onChanged={async () => setApprovals(await loadApprovals(approval.runId))}
              onError={setError}
            />
          ))}
          {selectedRun && (
            <div className="timeline-toolbar">
              <div>
                <span className="eyebrow">EVENTS</span>
                <strong>{filteredEvents.length} / {events.length}</strong>
              </div>
              <div className="filter-strip event-filters" aria-label="事件筛选">
                {EVENT_FILTERS.map((filter) => (
                  <button
                    className={eventFilter === filter.id ? "active" : ""}
                    key={filter.id}
                    onClick={() => setEventFilter(filter.id)}
                  >{filter.label}</button>
                ))}
              </div>
            </div>
          )}
          <div className="timeline">
            {selectedRun && events.length === 0 && (
              <div className="empty state-card"><span className="state-spinner" />正在等待第一条事件…</div>
            )}
            {events.length > 0 && filteredEvents.length === 0 && (
              <div className="empty state-card">
                <strong>当前筛选没有事件</strong>
                <button className="text-button" onClick={() => setEventFilter("all")}>显示全部事件</button>
              </div>
            )}
            {filteredEvents.map((event) => (
              <button
                className={`event-row ${event.eventId === selectedEventId ? "selected" : ""}`}
                key={event.eventId}
                onClick={() => setSelectedEventId(event.eventId)}
              >
                <span className={`event-node ${event.status}`} />
                <span className="sequence">{String(event.sequenceNo).padStart(2, "0")}</span>
                <span className="event-main">
                  <strong>{eventTitle(event)}</strong>
                  <small>{event.actor.id} · {formatTime(event.occurredAt)}</small>
                </span>
                <span className="event-kind">{event.eventType}</span>
              </button>
            ))}
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">EVIDENCE</span>
              <h2>原始证据</h2>
            </div>
          </div>
          {selectedEvent ? (
            <EventInspector key={selectedEvent.eventId} event={selectedEvent} />
          ) : (
            <div className="empty">选择一个事件查看参数、结果、diff 与哈希。</div>
          )}
        </aside>
      </section>
    </main>
  );
}

function AdapterCapabilityCard({ event }: { event: Event }) {
  const capabilities = isRecord(event.payload.capabilities)
    ? Object.entries(event.payload.capabilities)
    : [];
  return (
    <section className="adapter-card" aria-label="Agent Adapter 能力">
      <div className="adapter-title">
        <div>
          <span className="eyebrow">AGENT ADAPTER</span>
          <strong>{String(event.payload.provider ?? "unknown")} · {String(event.payload.mode ?? "unknown")}</strong>
        </div>
        <div className="adapter-versions">
          <code>adapter {String(event.payload.adapterVersion ?? "unknown")}</code>
          <code>{String(event.payload.runtimeVersion ?? "runtime unknown")}</code>
        </div>
      </div>
      <div className="capability-grid">
        {capabilities.map(([name, value]) => (
          <span className={`capability ${capabilityClass(value)}`} key={name}>
            <code>{name}</code>
            <strong>{String(value)}</strong>
          </span>
        ))}
      </div>
      <p>{String(event.payload.mode).startsWith("hosted")
        ? "Hosted 模式以 Provider 事件、Gateway 和系统观察证据对账；最终覆盖以 Hosted 控制卡为准。"
        : "Instrumented 模式记录 Codex 事件并核对项目文件变化；审批桥接、源工作区隔离和工具网络控制尚未接管。"}</p>
    </section>
  );
}

function HostedLaunchCard({
  suggestedProjectPath,
  onCreated,
  onError
}: {
  suggestedProjectPath?: string;
  onCreated: (run: Run) => void | Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projectPath, setProjectPath] = useState(suggestedProjectPath ?? "");
  const [task, setTask] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("workspace-write");
  const [timeoutMinutes, setTimeoutMinutes] = useState("5");
  const [storeModelContent, setStoreModelContent] = useState(false);
  const [preflight, setPreflight] = useState<HostedPreflight>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectPath.length === 0 && suggestedProjectPath !== undefined) {
      setProjectPath(suggestedProjectPath);
    }
  }, [projectPath.length, suggestedProjectPath]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadHostedPreflight(projectPath).then((next) => {
        if (!cancelled) setPreflight(next);
      }).catch((reason: unknown) => {
        if (!cancelled) setPreflight(undefined);
        onError(messageOf(reason));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectPath, onError]);

  const launch = async () => {
    setBusy(true);
    onError(undefined);
    try {
      const minutes = Number(timeoutMinutes);
      const result = await mutate<{ run: Run }>("/api/v1/hosted-runs", {
        projectPath,
        task,
        sandbox,
        timeoutMs: Math.round(minutes * 60_000),
        storeModelContent
      });
      setTask("");
      setOpen(false);
      await onCreated(result.run);
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`hosted-launch ${open ? "open" : ""}`} aria-label="启动 Hosted Codex">
      <button className="hosted-launch-toggle" onClick={() => setOpen((value) => !value)}>
        <span><strong>Hosted Run</strong><small>隔离 worktree · Observed</small></span>
        <span>{open ? "收起" : "启动"}</span>
      </button>
      {open && (
        <div className="hosted-launch-form">
          <label>Git 项目根目录<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/absolute/path/to/project" /></label>
          <label>任务<textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="说明 Codex 要完成的任务" rows={4} /></label>
          <div className="hosted-launch-row">
            <label>Sandbox<select value={sandbox} onChange={(event) => setSandbox(event.target.value as typeof sandbox)}><option value="workspace-write">workspace-write</option><option value="read-only">read-only</option></select></label>
            <label>超时（分钟）<input type="number" min="1" max="30" value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} /></label>
          </div>
          <label className="hosted-checkbox"><input type="checkbox" checked={storeModelContent} onChange={(event) => setStoreModelContent(event.target.checked)} />保留经遮盖的模型正文</label>
          <div className={`hosted-preflight ${preflight?.ready ? "ready" : "blocked"}`}>
            <strong>{preflight?.ready ? "预检通过" : "启动受阻"}</strong>
            <span>{preflight?.ready
              ? `${preflight.runtimeVersion ?? "Codex"} · Provider egress ${preflight.constraints.providerEgressAllowlistCount} hosts · diff ≤ ${Math.round(preflight.constraints.maximumDiffBytes / 1024 / 1024)} MiB`
              : preflight?.reasons[0] ?? "正在检查运行环境…"}</span>
          </div>
          <button className="hosted-primary" disabled={busy || preflight?.ready !== true || task.trim().length === 0} onClick={() => void launch()}>
            {busy ? "正在创建…" : "在隔离 worktree 中启动"}
          </button>
        </div>
      )}
    </section>
  );
}

function HostedControlCard({
  runId,
  summary,
  onChanged,
  onError
}: {
  runId: string;
  summary: HostedSummary;
  onChanged: () => void | Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [followup, setFollowup] = useState("");
  const [hostedDiff, setHostedDiff] = useState<HostedDiff>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [promotionPlan, setPromotionPlan] = useState<PromotionPlan>();
  const [promotionReview, setPromotionReview] = useState<PromotionReview>();
  const session = summary.session;
  const pendingActions = summary.actionRequests.filter(({ status }) =>
    status === "evaluating" || status === "waiting_approval"
  ).length;
  const deniedNetwork = summary.networkMediation.filter(({ decision }) => decision === "denied").length;
  const latestNetwork = summary.networkMediation.slice(-6).reverse();
  const latestPromotion = summary.promotions[0];
  const capabilityEntries = Object.entries(session?.capabilities ?? {});
  const governed = session?.mode === "hosted-governed" &&
    summary.coverage.coverageLevel === "L3" &&
    session.capabilities.hostedGovernance?.state === "supported";

  useEffect(() => {
    let cancelled = false;
    if (summary.workspace?.status !== "finalized") {
      setHostedDiff(undefined);
      setPromotionReview(undefined);
      setSelectedPaths([]);
      return;
    }
    void Promise.all([loadHostedDiff(runId), loadPromotionReview(runId)]).then(([next, review]) => {
      if (cancelled) return;
      setHostedDiff(next);
      setPromotionReview(review);
      setSelectedPaths((current) => current.length === 0 ? next.changedPaths : current);
    }).catch((reason: unknown) => {
      if (!cancelled) onError(messageOf(reason));
    });
    return () => { cancelled = true; };
  }, [runId, summary.workspace?.status, summary.workspace?.diffBlobHash, onError]);

  useEffect(() => {
    let cancelled = false;
    if (latestPromotion === undefined) {
      setPromotionPlan(undefined);
      return;
    }
    void loadPromotion(latestPromotion.id).then((plan) => {
      if (!cancelled) setPromotionPlan(plan);
    }).catch((reason: unknown) => {
      if (!cancelled) onError(messageOf(reason));
    });
    return () => { cancelled = true; };
  }, [latestPromotion?.id, onError]);

  const perform = async (kind: "cancel" | "finish" | "continue" | "promote") => {
    setBusy(kind);
    onError(undefined);
    try {
      if (kind === "cancel") await mutate(`/api/v1/hosted-runs/${encodeURIComponent(runId)}/cancel`, {});
      if (kind === "finish") await mutate(`/api/v1/hosted-runs/${encodeURIComponent(runId)}/finish`, {});
      if (kind === "continue") {
        await mutate(`/api/v1/hosted-runs/${encodeURIComponent(runId)}/turns`, {
          text: followup,
          sandbox: "read-only"
        });
        setFollowup("");
      }
      if (kind === "promote") {
        await mutate(`/api/v1/runs/${encodeURIComponent(runId)}/promotions`, {
          selectedPaths,
          reason: "Reviewed in Hosted Control diff"
        });
      }
      await onChanged();
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const exportRun = async () => {
    setExporting(true);
    onError(undefined);
    try {
      await downloadRunExport(runId);
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="hosted-card" aria-label="Hosted Codex 控制状态">
      <div className="hosted-title">
        <div>
          <span className="eyebrow">HOSTED CONTROL</span>
          <strong>{session?.provider ?? "Hosted workspace"}</strong>
        </div>
        <div className="hosted-title-actions">
          <Status status={summary.lifecycle.state} />
          {session && <Status status={session.status} />}
          <button onClick={() => void exportRun()} disabled={exporting}>
            {exporting ? "导出中…" : "导出证据"}
          </button>
        </div>
      </div>

      {(summary.lifecycle.canCancel || summary.lifecycle.canContinue || summary.lifecycle.canFinish) && (
        <div className="hosted-controls">
          <div className="hosted-control-actions">
            {summary.lifecycle.canCancel && <button className="danger" disabled={busy !== undefined} onClick={() => void perform("cancel")}>取消并停止 Host</button>}
            {summary.lifecycle.canFinish && <button disabled={busy !== undefined} onClick={() => void perform("finish")}>完成并生成 diff</button>}
          </div>
          {summary.lifecycle.canContinue && (
            <div className="hosted-followup">
              <input value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder={summary.lifecycle.state === "interrupted" ? "以 read-only 恢复 Thread 并继续" : "继续给同一 Thread 输入"} />
              <button disabled={busy !== undefined || followup.trim().length === 0} onClick={() => void perform("continue")}>继续</button>
            </div>
          )}
        </div>
      )}

      <div className={`hosted-assurance ${governed ? "governed" : "observed"}`}>
        <strong>{governed ? "Hosted Governed" : "Hosted Observed"} · {summary.coverage.coverageLevel}</strong>
        <span>{governed
          ? "声明范围内的关键副作用已有完整控制证据。"
          : "当前不是完全监控；缺失或实验性能力会限制覆盖等级。"}</span>
      </div>

      <div className="hosted-facts">
        <div><span>事件覆盖</span><strong>{summary.coverage.coveragePercent.toFixed(1)}%</strong><small>{summary.coverage.normalizedEventCount}/{summary.coverage.providerEventCount} normalized</small></div>
        <div><span>证据链</span><strong>{summary.eventChainValid ? "有效" : "异常"}</strong><small>{summary.coverage.gapCount} gaps · {summary.coverage.unknownEventCount + summary.coverage.invalidEventCount} unknown/invalid</small></div>
        <div><span>隔离工作区</span><strong>{summary.workspace?.status ?? "未创建"}</strong><small>{summary.workspace === null ? "无 Hosted workspace" : `${summary.workspace.changedPaths.length} changed paths`}</small></div>
        <div><span>控制请求</span><strong>{summary.actionRequests.length}</strong><small>{pendingActions} pending</small></div>
        <div><span>网络证据</span><strong>{summary.networkEvidenceCount}</strong><small>{deniedNetwork} denied in recent evidence</small></div>
        <div><span>Promotion</span><strong>{latestPromotion?.status ?? "无"}</strong><small>{latestPromotion === undefined ? "尚无计划" : `${latestPromotion.selectedPaths.length} selected paths`}</small></div>
      </div>

      {session && (
        <div className="hosted-runtime">
          <span>Runtime</span><code>{session.runtimeVersion}</code>
          <span>协议</span><code>{session.protocolVersion}</code>
          <span>Thread</span><code>{session.externalSessionId ?? "尚未绑定"}</code>
          <span>Session</span><code title={session.id}>{shortId(session.id)}</code>
        </div>
      )}

      {capabilityEntries.length > 0 && (
        <div className="capability-grid hosted-capabilities">
          {capabilityEntries.map(([name, capability]) => (
            <span
              className={`capability ${capabilityClass(capability.state)}`}
              key={name}
              title={`${capability.source} · ${capability.version}${capability.detail === undefined ? "" : ` · ${capability.detail}`}`}
            >
              <code>{name}</code>
              <strong>{capability.state}</strong>
            </span>
          ))}
        </div>
      )}

      {summary.providerEvents.length > 0 && (
        <details className="hosted-detail-block">
          <summary>Provider Thread / Turn / Item <code>{summary.providerEvents.length}</code></summary>
          <div className="provider-tree">
            {summary.providerEvents.slice(-24).map((event) => (
              <div className={`provider-node ${event.parseStatus}`} key={event.id}>
                <code>#{event.arrivalSequence}</code>
                <span>{event.providerMethod}</span>
                <small title={event.providerThreadId}>{event.providerThreadId === undefined ? "—" : `T ${shortId(event.providerThreadId)}`}</small>
                <small title={event.providerTurnId}>{event.providerTurnId === undefined ? "—" : `↳ ${shortId(event.providerTurnId)}`}</small>
                <small title={event.providerItemId}>{event.providerItemId === undefined ? "—" : `↳ ${shortId(event.providerItemId)}`}</small>
                <strong>{event.parseStatus}</strong>
              </div>
            ))}
          </div>
        </details>
      )}

      {summary.actionRequests.length > 0 && (
        <details className="hosted-detail-block">
          <summary>Provider Action Requests <code>{summary.actionRequests.length}</code></summary>
          <div className="provider-actions">
            {summary.actionRequests.slice(-12).reverse().map((action) => (
              <div className="provider-action" key={action.id}>
                <strong>{action.providerMethod}</strong><Status status={action.status} />
                <code>{action.actionContext?.argv?.join(" ") ?? action.actionContext?.targets.map(({ canonicalId }) => canonicalId).join(", ") ?? "无已解析参数"}</code>
                {action.decisionReason && <small>{action.decisionReason}</small>}
              </div>
            ))}
          </div>
        </details>
      )}

      {latestNetwork.length > 0 && (
        <div className="hosted-network">
          <div className="hosted-subtitle"><span>最近网络决策</span><code>{latestNetwork.length}/{summary.networkEvidenceCount}</code></div>
          {latestNetwork.map((record) => (
            <div className="network-row" key={record.id}>
              <code>#{record.sequenceNo}</code>
              <span>{record.operation}</span>
              <small>{record.source}</small>
              <strong className={record.decision}>{record.decision}</strong>
            </div>
          ))}
        </div>
      )}

      {hostedDiff && (
        <div className="promotion-review">
          <div className="hosted-subtitle"><span>Promotion diff 审核</span><code>{hostedDiff.redactionState}</code></div>
          {promotionReview && (
            <div className={`promotion-drift ${promotionReview.ready ? "ready" : "drifted"}`}>
              <strong>{promotionReview.ready ? "未检测到漂移" : "检测到漂移，Promotion 将失败关闭"}</strong>
              <span>{promotionReview.baseline} · source {promotionReview.sourceDrifted ? "changed" : "stable"} · worktree {promotionReview.worktreeDrifted ? "changed" : "stable"}</span>
            </div>
          )}
          <div className="promotion-paths">
            {hostedDiff.changedPaths.map((path) => (
              <label key={path}>
                <input
                  type="checkbox"
                  checked={selectedPaths.includes(path)}
                  disabled={!summary.lifecycle.canPromote}
                  onChange={(event) => setSelectedPaths((current) => event.target.checked
                    ? [...new Set([...current, path])]
                    : current.filter((item) => item !== path))}
                />
                <code>{path}</code>
              </label>
            ))}
          </div>
          <pre className="promotion-diff">{hostedDiff.diff || "无文本 diff"}</pre>
          {summary.lifecycle.canPromote && (
            <button className="promotion-request" disabled={busy !== undefined || selectedPaths.length === 0 || promotionReview?.ready !== true} onClick={() => void perform("promote")}>提交 {selectedPaths.length} 个文件供人工审批</button>
          )}
          {latestPromotion && promotionPlan && (
            <div className="promotion-plan">
              <strong>不可变计划 · {latestPromotion.status}</strong>
              <code title={latestPromotion.planHash}>{shortId(latestPromotion.planHash)}</code>
              <span>{promotionPlan.entries.length} entries · source/worktree 指纹已绑定</span>
            </div>
          )}
        </div>
      )}

      {(summary.lifecycle.lastError || session?.lastErrorMessage || summary.workspace?.lastErrorMessage || latestPromotion?.errorMessage) && (
        <p className="inline-error">
          {summary.lifecycle.lastError ?? session?.lastErrorMessage ?? summary.workspace?.lastErrorMessage ?? latestPromotion?.errorMessage}
        </p>
      )}
    </section>
  );
}

function ReplayLab({
  run,
  selectedEventId,
  checkpoints,
  replays,
  onCheckpointsChanged,
  onReplaysChanged,
  onRunsChanged,
  onError
}: {
  run: Run;
  selectedEventId?: string;
  checkpoints: Checkpoint[];
  replays: Replay[];
  onCheckpointsChanged: (checkpoints: Checkpoint[]) => void;
  onReplaysChanged: (replays: Replay[]) => void;
  onRunsChanged: (runs: Run[]) => void;
  onError: (message: string | undefined) => void;
}) {
  const [open, setOpen] = useState(run.status === "failed");
  const [checkpointId, setCheckpointId] = useState<string>();
  const [commandJson, setCommandJson] = useState('["node", "fixture-agent.mjs", "correct"]');
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState<"checkpoint" | "replay" | "export">();
  const latestReplay = replays[0];

  useEffect(() => {
    setCheckpointId((current) =>
      current !== undefined && checkpoints.some((checkpoint) => checkpoint.id === current)
        ? current
        : checkpoints[0]?.id
    );
  }, [checkpoints]);

  const createCheckpoint = async () => {
    setBusy("checkpoint");
    onError(undefined);
    try {
      const result = await mutate<{ checkpoint: Checkpoint }>("/api/v1/checkpoints", {
        runId: run.id,
        ...(selectedEventId === undefined ? {} : { sourceEventId: selectedEventId })
      });
      const next = await loadCheckpoints(run.id);
      onCheckpointsChanged(next);
      setCheckpointId(result.checkpoint.id);
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const startReplay = async () => {
    setBusy("replay");
    onError(undefined);
    try {
      const parsed = JSON.parse(commandJson) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("命令必须是 JSON 字符串数组");
      }
      if (checkpointId === undefined) throw new Error("请先创建或选择 Checkpoint");
      await mutate<{ replay: Replay }>("/api/v1/replays", {
        checkpointId,
        command: parsed,
        ...(task.trim() === "" ? {} : { task: task.trim() }),
        overrides: { commandEditedInReplayLab: "true" }
      });
      const [nextReplays, nextRuns] = await Promise.all([loadReplays(run.id), loadRuns()]);
      onReplaysChanged(nextReplays);
      onRunsChanged(nextRuns);
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const exportRun = async () => {
    setBusy("export");
    onError(undefined);
    try {
      await downloadRunExport(run.id);
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="replay-lab">
      <button className="replay-toggle" onClick={() => setOpen((value) => !value)}>
        <span><span className="eyebrow">REPLAY LAB</span><strong>Checkpoint 与隔离分叉</strong></span>
        <span>{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="replay-body">
          <div className="replay-safety">
            <strong>Isolated Live</strong>
            <span>仅写入独立 Git worktree；网络、发布、删除与 shell 命令默认拒绝。</span>
          </div>
          <div className="replay-form">
            <label>
              Checkpoint
              <select value={checkpointId ?? ""} onChange={(event) => setCheckpointId(event.target.value || undefined)}>
                <option value="">尚未创建</option>
                {checkpoints.map((checkpoint) => (
                  <option key={checkpoint.id} value={checkpoint.id}>
                    {shortId(checkpoint.id)} · {formatDateTime(checkpoint.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy !== undefined} onClick={() => void createCheckpoint()}>
              {busy === "checkpoint" ? "保存中…" : "保存当前工作区 Checkpoint"}
            </button>
            <label className="replay-wide">
              分叉任务说明（可选）
              <input value={task} onChange={(event) => setTask(event.target.value)} placeholder="例如：改用正确依赖并重新运行测试" />
            </label>
            <label className="replay-wide">
              执行 argv（JSON 数组）
              <input value={commandJson} onChange={(event) => setCommandJson(event.target.value)} spellCheck={false} />
            </label>
          </div>
          <div className="replay-actions">
            <button className="replay-start" disabled={busy !== undefined || checkpointId === undefined} onClick={() => void startReplay()}>
              {busy === "replay" ? "隔离回放中…" : "创建分支并回放"}
            </button>
            <button disabled={busy !== undefined} onClick={() => void exportRun()}>
              {busy === "export" ? "导出中…" : "导出 Run JSON"}
            </button>
          </div>
          {latestReplay && (
            <article className={`replay-result ${latestReplay.status}`}>
              <div className="replay-result-title">
                <strong>最近一次分叉</strong>
                <Status status={latestReplay.status} />
              </div>
              <div className="replay-facts">
                <span>新 Run</span><code>{latestReplay.targetRunId}</code>
                <span>分叉事件</span><code>{latestReplay.sourceEventId ?? "—"}</code>
                <span>worktree</span><code>{latestReplay.worktreePath}</code>
                {latestReplay.errorMessage && <><span>失败原因</span><span className="warning-text">{latestReplay.errorMessage}</span></>}
              </div>
              {latestReplay.comparison && <ComparisonView comparison={latestReplay.comparison} />}
            </article>
          )}
        </div>
      )}
    </section>
  );
}

function ComparisonView({ comparison }: { comparison: NonNullable<Replay["comparison"]> }) {
  return (
    <div className="comparison">
      <h3>新旧 Run 对比</h3>
      <div className="comparison-grid">
        <span>维度</span><strong>原 Run</strong><strong>分叉 Run</strong>
        <span>状态</span><Status status={comparison.source.status} /><Status status={comparison.target.status} />
        <span>命令</span><code>{comparison.source.toolCallCount}</code><code>{comparison.target.toolCallCount}</code>
        <span>审批</span><code>{comparison.source.approvalCount}</code><code>{comparison.target.approvalCount}</code>
        <span>文件</span><code>{comparison.source.changedFiles.join(", ") || "—"}</code><code>{comparison.target.changedFiles.join(", ") || "—"}</code>
        <span>退出结果</span><code>{lastExit(comparison.source)}</code><code>{lastExit(comparison.target)}</code>
      </div>
      {comparison.delta.filesOnlyInTarget.length > 0 && (
        <p>分叉新增变更：{comparison.delta.filesOnlyInTarget.join(", ")}</p>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  onChanged,
  onError
}: {
  approval: Approval;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState<"approved" | "denied">();
  const [decisionReason, setDecisionReason] = useState("");
  const [snapshotContent, setSnapshotContent] = useState<string>();
  const [snapshotError, setSnapshotError] = useState<string>();
  const decide = async (decision: "approved" | "denied") => {
    setSubmitting(decision);
    try {
      await mutate(`/api/v1/approvals/${approval.id}/decision`, {
        decision,
        ...(decisionReason.trim() === "" ? {} : { reason: decisionReason.trim() })
      });
      await onChanged();
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setSubmitting(undefined);
    }
  };
  return (
    <article className={`approval-card ${approval.status}`}>
      <div className="approval-title">
        <span className={`risk ${approval.riskLevel.toLowerCase()}`}>{approval.riskLevel}</span>
        <div>
          <span className="eyebrow">APPROVAL</span>
          <h3>{approval.actionContext.tool} / {approval.actionContext.action}</h3>
        </div>
        <Status status={approval.status} />
      </div>
      <div className="approval-facts">
        <span>发起者</span><code>{approval.actionContext.actor.type}/{approval.actionContext.actor.id}</code>
        <span>完整目标</span>
        <div className="approval-targets">
          {approval.actionContext.targets.map((target) => <code key={`${target.type}:${target.canonicalId}`}>{target.canonicalId}</code>)}
        </div>
        <span>原始参数</span><code>{approval.actionContext.argv?.join(" ") ?? "—"}</code>
        <span>命中规则</span><code>{approval.ruleId} · {approval.reasonCodes.join(", ")}</code>
        <span>申请理由</span><span>{approval.requestReason ?? "未提供"}</span>
        <span>预计影响</span>
        <span>{approval.actionContext.estimatedImpact === undefined ? "未估算" : impactLabel(approval.actionContext.estimatedImpact)}</span>
        <span>可恢复性</span><span>{recoverabilityLabel(approval.actionContext.recoverability)}</span>
        <span>执行前快照</span>
        {approval.snapshotId === undefined ? (
          <span className="warning-text">尚未创建（仅审批记录，未经过 Gateway）</span>
        ) : (
          <button
            className="snapshot-button"
            onClick={() => void loadSnapshotContent(approval.snapshotId!, setSnapshotContent, setSnapshotError)}
          >
            {snapshotContent === undefined ? `查看 ${shortId(approval.snapshotId)}` : "已加载删除前内容"}
          </button>
        )}
        <span>审批期限</span><time>{formatDateTime(approval.requestExpiresAt)}</time>
        <span>动作摘要</span><code title={approval.actionDigest}>{approval.actionDigest.slice(0, 20)}…</code>
      </div>
      {snapshotContent !== undefined && <pre className="snapshot-preview">{snapshotContent}</pre>}
      {snapshotError !== undefined && <p className="inline-error snapshot-error">快照加载失败：{snapshotError}</p>}
      {approval.status === "pending" ? (
        <div className="approval-decision">
          <input
            value={decisionReason}
            onChange={(event) => setDecisionReason(event.target.value)}
            placeholder="决定说明或拒绝原因（可选）"
            maxLength={500}
          />
          <div className="approval-actions">
            <button
              className="approve-button"
              disabled={submitting !== undefined}
              onClick={() => void decide("approved")}
            >
              {submitting === "approved" ? "批准中…" : "仅本次批准"}
            </button>
            <button className="scope-button" disabled title="限定范围授权将在策略配置模块实现">
              限定范围批准（未开放）
            </button>
            <button
              className="deny-button"
              disabled={submitting !== undefined}
              onClick={() => void decide("denied")}
            >
              {submitting === "denied" ? "拒绝中…" : "拒绝"}
            </button>
          </div>
        </div>
      ) : (
        <div className="approval-history">
          {approval.decidedBy ? `由 ${approval.decidedBy} 处理` : "审批已超时"}
          {approval.decisionReason ? ` · ${approval.decisionReason}` : ""}
        </div>
      )}
    </article>
  );
}

function EventInspector({ event }: { event: Event }) {
  const diff = typeof event.payload.diff === "string" ? event.payload.diff : undefined;
  return (
    <div className="inspector-content">
      <div className="fact-grid">
        <span>事件</span><code>{event.eventType}</code>
        <span>状态</span><Status status={event.status} />
        <span>Actor</span><code>{event.actor.type}/{event.actor.id}</code>
        <span>序号</span><code>{event.sequenceNo}</code>
      </div>
      {diff && (
        <section className="evidence-block">
          <h3>文件 Diff</h3>
          <pre className="diff">{diff}</pre>
        </section>
      )}
      <OutputBlob label="完整 stdout" value={event.payload.stdout} />
      <OutputBlob label="完整 stderr" value={event.payload.stderr} />
      <details className="evidence-block" open={!hasTruncatedOutput(event.payload)}>
        <summary>Payload{hasTruncatedOutput(event.payload) ? "（大输出已折叠）" : ""}</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
      <section className="integrity">
        <span>内容哈希</span>
        <code title={event.contentHash}>{event.contentHash.slice(0, 18)}…</code>
      </section>
    </div>
  );
}

function OutputBlob({ label, value }: { label: string; value: unknown }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const output = value as { truncated?: boolean; blobRef?: string } | undefined;
  if (output?.truncated !== true || output.blobRef === undefined) {
    return null;
  }
  const hash = output.blobRef.replace(/^sha256:/, "");
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/blobs/${hash}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      setContent(await response.text());
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="evidence-block">
      <h3>{label}</h3>
      {content === undefined ? (
        <button className="load-blob" onClick={() => void load()} disabled={loading}>
          {loading ? "加载中…" : `按需加载 ${output.blobRef.slice(0, 18)}…`}
        </button>
      ) : (
        <pre>{content}</pre>
      )}
      {error && <p className="inline-error">加载失败：{error}</p>}
    </section>
  );
}

function Status({ status }: { status: string }) {
  const labels: Record<string, string> = {
    created: "已创建",
    running: "运行中",
    starting: "启动中",
    idle: "等待输入",
    stopping: "停止中",
    waiting_approval: "等待审批",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    unavailable: "不可用",
    success: "成功",
    error: "错误",
    pending: "等待",
    queued: "排队中",
    unknown: "未知",
    approved: "已批准",
    consumed: "已消费",
    denied: "已拒绝",
    expired: "已过期"
  };
  return <span className={`status ${status}`}>{labels[status] ?? status}</span>;
}

function Validation({ status }: { status: Run["validationStatus"] }) {
  const labels = { passed: "验证通过", failed: "验证失败", unverified: "尚未验证" };
  return <span className={`validation ${status}`}>{labels[status]}</span>;
}

async function loadMeta(): Promise<Meta> {
  return request<Meta>("/api/v1/meta");
}

async function loadRuns(): Promise<Run[]> {
  return (await request<{ runs: Run[] }>("/api/v1/runs")).runs;
}

async function loadEvents(runId: string): Promise<Event[]> {
  return (await request<{ events: Event[] }>(`/api/v1/runs/${runId}/events`)).events;
}

async function loadApprovals(runId: string): Promise<Approval[]> {
  return (await request<{ approvals: Approval[] }>(`/api/v1/approvals?runId=${encodeURIComponent(runId)}`)).approvals;
}

async function loadCheckpoints(runId: string): Promise<Checkpoint[]> {
  return (await request<{ checkpoints: Checkpoint[] }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/checkpoints`
  )).checkpoints;
}

async function loadReplays(runId: string): Promise<Replay[]> {
  return (await request<{ replays: Replay[] }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/replays`
  )).replays;
}

async function loadHostedSummary(runId: string): Promise<HostedSummary> {
  return request<HostedSummary>(`/api/v1/runs/${encodeURIComponent(runId)}/hosted-summary`);
}

async function loadHostedPreflight(projectPath: string): Promise<HostedPreflight> {
  const query = projectPath.trim().length === 0 ? "" : `?projectPath=${encodeURIComponent(projectPath)}`;
  return (await request<{ preflight: HostedPreflight }>(`/api/v1/hosted/preflight${query}`)).preflight;
}

async function loadHostedDiff(runId: string): Promise<HostedDiff> {
  return request<HostedDiff>(`/api/v1/runs/${encodeURIComponent(runId)}/hosted-diff`);
}

async function loadPromotion(promotionId: string): Promise<PromotionPlan> {
  return (await request<{ plan: PromotionPlan }>(
    `/api/v1/promotions/${encodeURIComponent(promotionId)}`
  )).plan;
}

async function loadPromotionReview(runId: string): Promise<PromotionReview> {
  return (await request<{ review: PromotionReview }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/promotion-review`
  )).review;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function mutate<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json()) as T;
}

async function downloadRunExport(runId: string): Promise<void> {
  const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/export`, {
    method: "POST",
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(await responseError(response));
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `afr-run-${runId}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string; code?: string };
    return body.message === undefined
      ? `${response.status} ${response.statusText}`
      : `${body.code ?? response.status}: ${body.message}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function loadSnapshotContent(
  snapshotId: string,
  setContent: (value: string) => void,
  setError: (value: string | undefined) => void
): Promise<void> {
  setError(undefined);
  try {
    const metadata = await request<{ blobRef: string }>(`/api/v1/snapshots/${snapshotId}`);
    const response = await fetch(`/api/v1/blobs/${metadata.blobRef.replace(/^sha256:/, "")}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    setContent(await response.text());
  } catch (reason) {
    setError(messageOf(reason));
  }
}

function recoverabilityLabel(value: string): string {
  return value === "easy" ? "容易恢复" : value === "partial" ? "部分可恢复" : "不可恢复";
}

function impactLabel(value: Record<string, number>): string {
  return Object.entries(value).map(([name, count]) => `${name}: ${count}`).join(" · ");
}

function matchesRunFilter(run: Run, filter: RunFilter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return run.status === "failed";
  if (filter === "waiting") return run.status === "waiting_approval" || run.pendingApprovalCount > 0;
  if (filter === "high-risk") return run.highRiskCount > 0;
  if (filter === "unverified") return run.validationStatus === "unverified";
  return run.gapCount > 0;
}

function matchesEventFilter(event: Event, filter: EventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "commands") {
    return event.eventType.startsWith("shell.") || event.eventType.startsWith("tool.");
  }
  if (filter === "files") return event.eventType.startsWith("file.");
  if (filter === "risk") {
    return event.eventType.startsWith("policy.") ||
      event.eventType.startsWith("approval.") ||
      event.eventType.startsWith("security.") ||
      event.eventType.startsWith("snapshot.");
  }
  return event.status === "error" || event.eventType === "collection.gap_detected";
}

function runIdFromPath(): string | undefined {
  const match = window.location.pathname.match(/^\/runs\/([^/]+)$/);
  return match?.[1];
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;
}

function formatDuration(run: Run): string {
  if (run.startedAt === undefined) return "未开始";
  const end = run.endedAt === undefined ? Date.now() : new Date(run.endedAt).getTime();
  const duration = Math.max(0, end - new Date(run.startedAt).getTime());
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)} s`;
  return `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1_000)}s`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function eventTitle(event: Event): string {
  const path = typeof event.payload.path === "string" ? event.payload.path : undefined;
  const argv = Array.isArray(event.payload.argv) ? event.payload.argv.join(" ") : undefined;
  if (event.eventType === "artifact.created" && event.payload.kind === "agent_adapter_capabilities") {
    return "记录 Agent Adapter 能力";
  }
  if (event.eventType === "artifact.created" && event.payload.kind === "codex_file_reconciliation") {
    return "完成 Provider 文件声明对账";
  }
  if (event.eventType === "artifact.created" && event.payload.kind === "provider_file_change_claim") {
    return "Codex 声明文件修改完成";
  }
  const labels: Record<string, string> = {
    "run.created": "创建运行",
    "run.status_changed": `状态变为 ${String(event.payload.to ?? "未知")}`,
    "agent.session_started": "Codex 会话已启动",
    "agent.turn_started": "Codex Turn 已启动",
    "agent.turn_completed": "Codex Turn 已完成",
    "agent.turn_failed": "Codex Turn 失败",
    "model.response": "收到模型响应",
    "tool.call_requested": "工具调用已请求",
    "tool.call_started": "工具调用已开始",
    "tool.call_completed": "工具调用已完成",
    "tool.call_failed": "工具调用失败",
    "shell.command_requested": argv ? `准备执行 ${argv}` : "准备执行命令",
    "shell.command_completed": argv ? `执行 ${argv}` : "命令执行完成",
    "file.write_requested": "Codex 声明准备修改文件",
    "file.created": path ? `创建 ${path}` : "创建文件",
    "file.modified": path ? `修改 ${path}` : "修改文件",
    "file.deleted": path ? `删除 ${path}` : "删除文件",
    "policy.evaluated": "完成风险策略判断",
    "approval.requested": "等待用户审批",
    "approval.decided": event.payload.decision === "approved" ? "审批已批准" : "审批已拒绝",
    "approval.expired": "审批或授权已过期",
    "approval.consumed": "已消费一次性授权",
    "security.grant_rejected": "拒绝无效执行授权",
    "checkpoint.created": "创建工作区 Checkpoint",
    "replay.started": "开始隔离回放",
    "replay.completed": event.status === "success" ? "隔离回放完成" : "隔离回放失败",
    "file.diff_created": "生成工作区 Diff",
    "collection.gap_detected": "发现采集缺口"
  };
  return labels[event.eventType] ?? event.eventType;
}

function adapterSummary(event: Event): string {
  const provider = String(event.payload.provider ?? "unknown");
  const mode = String(event.payload.mode ?? "unknown");
  const runtime = String(event.payload.runtimeVersion ?? "runtime unknown");
  return `${provider} ${mode} · ${runtime}`;
}

function capabilityClass(value: unknown): string {
  if (value === "supported") return "supported";
  if (value === "unsupported") return "unsupported";
  return "degraded";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lastExit(side: RunComparisonSide): string {
  const command = side.commands.at(-1);
  return command === undefined ? "—" : `${command.exitCode ?? "无退出码"} / ${command.status}`;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function hasTruncatedOutput(payload: Record<string, unknown>): boolean {
  return [payload.stdout, payload.stderr].some(
    (value) => (value as { truncated?: boolean } | undefined)?.truncated === true
  );
}
