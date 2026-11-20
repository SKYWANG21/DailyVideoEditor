import type { GradeContextEvent } from "@/types/videoAdjustmentWorker";

/** 开发模式对照入口，生产预览自动选择后端。 */
export function readGradeBenchmarkMode(): "cpu" | "gpu" | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  const mode = new URLSearchParams(location.search).get("gradeBench");
  return mode === "cpu" || mode === "gpu" ? mode : null;
}

/** 一个播放器的开发诊断；生命周期按播放器累计，帧指标在每段播放开始时清零。 */
export class GradeBenchmark {
  readonly contexts: Record<GradeContextEvent, number> = {
    created: 0,
    createFailed: 0,
    lost: 0,
    restored: 0,
    rebuilt: 0,
    rebuildFailed: 0,
  };
  workersCreated = 0;
  readonly terminations: Record<string, number> = {};
  private lastBackend = "";
  private lostAt: number | null = null;
  private restoredAt: number | null = null;
  private previousPresent: number | null = null;
  private samples = { gpu: [] as number[], cpu: [] as number[] };
  private counts = { gpu: 0, cpu: 0 };
  private fallbackReasons: Record<string, number> = {};
  private stale = 0;
  coalescedSeeks = 0;
  private maxGap = 0;
  private scrubMs: number | null = null;
  private fallbackMs: number | null = null;
  private restoreMs: number | null = null;
  private inputSize: readonly number[] = [];

  /** 保持早于播放开始的上下文事件和最近一次松手耗时。 */
  begin(): void {
    this.counts = { gpu: 0, cpu: 0 };
    this.samples = { gpu: [], cpu: [] };
    this.fallbackReasons = {};
    this.stale = this.maxGap = this.coalescedSeeks = 0;
    this.restoreMs = this.fallbackMs = this.previousPresent = null;
  }

  /** 对齐主线程收到的事件和结果，避免跨 Worker 相减不同的时钟。 */
  context(event: GradeContextEvent): void {
    this.contexts[event]++;
    if (event === "lost") {
      this.lostAt = performance.now();
      this.restoredAt = null;
    }
    if (event === "restored") this.restoredAt = performance.now();
  }

  /** 按实际完成的调色请求采集耗时，最近 256 个样本用于分位数。 */
  frame(backend: "gpu" | "cpu", reason: string | undefined, start: number, width: number, height: number, stale: boolean): void {
    const now = performance.now();
    const count = this.counts[backend]++;
    this.samples[backend][count % 256] = now - start;
    this.inputSize = [width, height];
    if (stale) this.stale++;
    if (reason) {
      this.fallbackReasons[reason] = (this.fallbackReasons[reason] ?? 0) + 1;
      if (this.lostAt !== null) this.fallbackMs = now - this.lostAt;
      this.lostAt = null;
    }
    if (backend === "gpu") {
      if (this.restoredAt !== null) this.restoreMs = now - this.restoredAt;
      this.restoredAt = this.lostAt = null;
    }
    if (backend !== this.lastBackend) {
      this.lastBackend = backend;
      if (reason) console.warn("[grade-bench] GPU 回退到 CPU", reason);
      else console.info("[grade-bench] 调色后端", backend.toUpperCase());
    }
  }

  /** 暂停和重新定位之间的时间不纳入播放帧间隔。 */
  breakInterval(): void {
    this.previousPresent = null;
  }

  /** 仅在画面已提交后记录间隔，松手定位在暂停时也独立输出。 */
  present(playing: boolean, scrubStart?: number): void {
    const now = performance.now();
    if (playing && this.previousPresent !== null) this.maxGap = Math.max(this.maxGap, now - this.previousPresent);
    this.previousPresent = playing ? now : null;
    if (scrubStart !== undefined) {
      this.scrubMs = now - scrubStart;
      console.info("[grade-bench] 时间轴松手", { scrubToPresentMs: this.scrubMs, coalescedSeeks: this.coalescedSeeks });
    }
  }

  /** 汇总时才排序，帧循环无需排序或 GPU 回读。 */
  summary(): object {
    const timing = (samples: number[]): { p50: number | null; p95: number | null } => {
      const sorted = [...samples].sort((a, b) => a - b);
      return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
    };
    return {
      gpuGradeFrames: this.counts.gpu,
      cpuGradeFrames: this.counts.cpu,
      fallbackFrames: Object.values(this.fallbackReasons).reduce((total, value) => total + value, 0),
      fallbackReasons: { ...this.fallbackReasons },
      staleGradeFrames: this.stale,
      coalescedSeeks: this.coalescedSeeks,
      scrubToPresentMs: this.scrubMs,
      maxPresentGapMs: this.maxGap,
      lossToCpuMs: this.fallbackMs,
      restoreToGpuMs: this.restoreMs,
      inputSize: this.inputSize,
      gradeEndToEndMs: { gpu: timing(this.samples.gpu), cpu: timing(this.samples.cpu) },
      lifetime: { workersCreated: this.workersCreated, workerTerminations: { ...this.terminations }, contexts: { ...this.contexts } },
    };
  }
}
