import { randomUUID } from 'node:crypto';

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Job<T = unknown> {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: T;
  error?: string;
  progress?: { processed: number; total?: number };
}

/**
 * In-memory job store for async endpoints (e.g. /crawl). Wiped on restart.
 *
 * Trade-off vs Redis/BullMQ: simpler, no extra service, but state is lost on
 * redeploy and doesn't survive multiple replicas. Acceptable for low-volume
 * workloads. Swap for a real queue when scaling out.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private maxJobs: number;

  constructor(maxJobs = 500) {
    this.maxJobs = maxJobs;
  }

  create<T>(): Job<T> {
    this.evictOldestIfFull();
    const job: Job<T> = {
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job as Job);
    return job;
  }

  get<T>(id: string): Job<T> | undefined {
    return this.jobs.get(id) as Job<T> | undefined;
  }

  update<T>(id: string, patch: Partial<Job<T>>): void {
    const existing = this.jobs.get(id);
    if (!existing) return;
    this.jobs.set(id, { ...existing, ...patch });
  }

  markRunning(id: string): void {
    this.update(id, { status: 'running', startedAt: new Date().toISOString() });
  }

  markSucceeded<T>(id: string, result: T): void {
    this.update(id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      result,
    });
  }

  markFailed(id: string, error: string): void {
    this.update(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error,
    });
  }

  updateProgress(id: string, processed: number, total?: number): void {
    this.update(id, { progress: { processed, total } });
  }

  private evictOldestIfFull(): void {
    if (this.jobs.size < this.maxJobs) return;
    const oldest = this.jobs.keys().next().value;
    if (oldest) this.jobs.delete(oldest);
  }
}
