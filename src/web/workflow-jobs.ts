import type { RunWorkflowEvent, RunWorkflowResult } from "../workflow/run-workflow.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";

export interface WorkflowJobSnapshot {
  jobId: string;
  status: "running" | "completed" | "failed" | "stopped";
  active: boolean;
  startedAt: string;
  elapsedSeconds: number;
  currentStep: string;
  logs: string[];
  designs: Array<{ version: string; content: string; path: string }>;
  reviews: DesignReview[];
  plan?: TaskPlan;
  result?: RunWorkflowResult;
  error?: string;
}

export interface WorkflowJobRuntime {
  snapshot: WorkflowJobSnapshot;
  controller: AbortController;
}

export class WorkflowJobStore {
  private readonly jobs = new Map<string, WorkflowJobRuntime>();
  private activeJobId: string | undefined;

  createJob(): WorkflowJobRuntime {
    const job: WorkflowJobSnapshot = {
      jobId: createJobId(),
      status: "running",
      active: true,
      startedAt: new Date().toISOString(),
      elapsedSeconds: 0,
      currentStep: "准备调用 Codex",
      logs: ["已创建治理流程任务，准备调用 Codex。"],
      designs: [],
      reviews: []
    };
    if (this.activeJobId) {
      const previous = this.jobs.get(this.activeJobId);
      if (previous) {
        previous.snapshot.active = false;
        previous.snapshot.logs.push("用户已补充需求并启动新流程，本任务结果不再作为当前页面状态。");
      }
    }
    const runtime = { snapshot: job, controller: new AbortController() };
    this.activeJobId = job.jobId;
    this.jobs.set(job.jobId, runtime);
    return runtime;
  }

  getJob(jobId: string): WorkflowJobSnapshot | undefined {
    const runtime = this.jobs.get(jobId);
    if (!runtime) {
      return undefined;
    }
    refreshElapsed(runtime.snapshot);
    return runtime.snapshot;
  }

  stopJob(jobId: string): WorkflowJobSnapshot | undefined {
    const runtime = this.jobs.get(jobId);
    if (!runtime) {
      return undefined;
    }
    runtime.controller.abort();
    runtime.snapshot.status = "stopped";
    runtime.snapshot.currentStep = "已停止";
    runtime.snapshot.logs.push("用户已停止当前治理流程。");
    refreshElapsed(runtime.snapshot);
    return runtime.snapshot;
  }

  recordEvent(jobId: string, event: RunWorkflowEvent): void {
    const runtime = this.jobs.get(jobId);
    if (!runtime) {
      return;
    }
    const job = runtime.snapshot;
    if (job.status === "stopped") {
      return;
    }

    switch (event.type) {
      case "workflow_started":
        job.currentStep = "流程已启动";
        job.logs.push(`流程已启动，产物目录：${event.artifactDir}`);
        break;
      case "design_started":
        job.currentStep = `等待 Codex 生成 ${event.designVersion}`;
        job.logs.push(`Codex 正在生成 ${event.designVersion}。`);
        break;
      case "design_completed":
        job.designs.push({
          version: event.designVersion,
          content: event.design,
          path: event.path
        });
        job.currentStep = `${event.designVersion} 已生成`;
        job.logs.push(`Codex 已生成 ${event.designVersion}：${event.path}`);
        break;
      case "review_started":
        job.currentStep = `等待 ClaudeCode 审查第 ${event.round} 轮`;
        job.logs.push(`ClaudeCode 正在审查第 ${event.round} 轮，对应 ${event.designVersion}。`);
        break;
      case "review_completed":
        job.reviews.push(event.review);
        job.currentStep = `第 ${event.review.round} 轮审查已完成`;
        job.logs.push(`ClaudeCode 第 ${event.review.round} 轮结论：${event.review.reviewDecision}。`);
        break;
      case "revision_started":
        job.currentStep = `等待 Codex 整改第 ${event.round} 轮意见`;
        job.logs.push(`Codex 正在根据第 ${event.round} 轮审查意见整改设计稿。`);
        break;
      case "planning_started":
        job.currentStep = "等待 ClaudeCode 生成任务计划";
        job.logs.push("设计已通过，ClaudeCode 正在生成结构化任务计划。");
        break;
      case "planning_completed":
        job.plan = event.plan;
        job.currentStep = "任务计划已生成";
        job.logs.push(`任务计划已生成：${event.path}`);
        break;
      case "workflow_completed":
        job.status = "completed";
        job.currentStep = "流程已完成";
        job.result = event.result;
        job.plan = event.result.plan;
        job.logs.push(`流程已完成，状态：${event.result.workflow.status}。`);
        break;
      case "workflow_failed":
        job.status = "failed";
        job.currentStep = "流程失败";
        job.error = event.message;
        job.logs.push(`流程失败：${event.message}`);
        break;
    }
    refreshElapsed(job);
  }

  failJob(jobId: string, error: unknown): void {
    const runtime = this.jobs.get(jobId);
    if (!runtime) {
      return;
    }
    const job = runtime.snapshot;
    if (job.status === "stopped") {
      return;
    }
    job.status = "failed";
    job.currentStep = "流程失败";
    job.error = error instanceof Error ? error.message : String(error);
    job.logs.push(`流程失败：${job.error}`);
    refreshElapsed(job);
  }
}

function createJobId(): string {
  return `JOB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function refreshElapsed(job: WorkflowJobSnapshot): void {
  job.elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000)
  );
}
