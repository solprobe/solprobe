import type { ExecuteJobResult } from "../runtime/offeringTypes.js";

const MAX_QUEUE_DEPTH = 50;

type Handler = (requirements: unknown) => Promise<ExecuteJobResult>;

interface QueueEntry {
  requirements: unknown;
  handler: Handler;
  resolve: (value: ExecuteJobResult) => void;
  reject: (reason: unknown) => void;
}

const queue: QueueEntry[] = [];
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const entry = queue.shift()!;
    try {
      const result = await entry.handler(entry.requirements);
      entry.resolve(result);
    } catch (err) {
      entry.reject(err);
    }
  }

  running = false;
}

export function enqueue(
  requirements: unknown,
  handler: Handler
): Promise<ExecuteJobResult> {
  if (queue.length >= MAX_QUEUE_DEPTH) {
    console.error(
      `[jobQueue] depth=${queue.length} — rejected (max ${MAX_QUEUE_DEPTH})`
    );
    return Promise.reject(
      new Error(`Job queue full (max depth ${MAX_QUEUE_DEPTH})`)
    );
  }

  return new Promise<ExecuteJobResult>((resolve, reject) => {
    queue.push({ requirements, handler, resolve, reject });
    console.log(`[jobQueue] depth=${queue.length}`);
    void drain();
  });
}
