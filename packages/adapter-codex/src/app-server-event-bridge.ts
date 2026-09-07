import type {
  LocalStore,
  ProviderEventRecord
} from "@afr/core";

import {
  CodexAppServerNormalizer,
  type AppServerNormalizerOptions
} from "./app-server-normalizer.js";
import type { AppServerNotification } from "./app-server-supervisor.js";

export type AppServerEventBridgeOptions = Omit<AppServerNormalizerOptions, "runId"> & {
  runId: string;
  providerSessionId: string;
  storeRaw?: boolean;
};

export class AppServerEventBridge {
  readonly normalizer: CodexAppServerNormalizer;

  constructor(
    private readonly store: LocalStore,
    private readonly options: AppServerEventBridgeOptions
  ) {
    const session = store.getProviderSession(options.providerSessionId);
    if (session === undefined || session.runId !== options.runId) {
      throw new Error("Provider session does not belong to the App Server Event Bridge Run");
    }
    this.normalizer = new CodexAppServerNormalizer({
      runId: options.runId,
      ...(options.runtimeVersion === undefined ? {} : { runtimeVersion: options.runtimeVersion }),
      ...(options.storeModelContent === undefined ? {} : { storeModelContent: options.storeModelContent }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  handle(notification: AppServerNotification): ProviderEventRecord {
    const normalized = this.normalizer.normalize(notification);
    return this.store.recordProviderEvent({
      sessionId: this.options.providerSessionId,
      method: notification.method,
      raw: notification,
      parseStatus: normalized.parseStatus,
      ...(normalized.providerEventId === undefined ? {} : { providerEventId: normalized.providerEventId }),
      ...(normalized.providerThreadId === undefined ? {} : { providerThreadId: normalized.providerThreadId }),
      ...(normalized.providerTurnId === undefined ? {} : { providerTurnId: normalized.providerTurnId }),
      ...(normalized.providerItemId === undefined ? {} : { providerItemId: normalized.providerItemId }),
      ...(normalized.gapReason === undefined ? {} : { gapReason: normalized.gapReason }),
      ...(normalized.event === undefined ? {} : { normalizedEvent: normalized.event }),
      ...(this.options.storeRaw === undefined ? {} : { storeRaw: this.options.storeRaw })
    });
  }
}
