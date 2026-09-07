import type { EventEnvelope } from "@afr/protocol";

type Listener = (event: EventEnvelope) => void;

export class EventStreamBroker {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      for (const listener of this.listeners.get(event.runId) ?? []) {
        listener(event);
      }
    }
  }

  subscribe(runId: string, listener: Listener): () => void {
    const runListeners = this.listeners.get(runId) ?? new Set<Listener>();
    runListeners.add(listener);
    this.listeners.set(runId, runListeners);
    return () => {
      runListeners.delete(listener);
      if (runListeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }
}

export function serializeSseEvent(event: EventEnvelope): string {
  return `id: ${event.sequenceNo}\nevent: afr-event\ndata: ${JSON.stringify(event)}\n\n`;
}
