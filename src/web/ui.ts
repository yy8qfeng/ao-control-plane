import { appVersion } from "../app-version.js";

export function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AO Control Plane</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --line: #d9dee8;
      --text: #1f2937;
      --muted: #687385;
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --ok: #13795b;
      --warn: #a16207;
      --bad: #b42318;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }

    main {
      display: grid;
      grid-template-columns: minmax(360px, 440px) minmax(0, 1fr);
      gap: 16px;
      padding: 16px;
      max-width: 1440px;
      margin: 0 auto;
    }

    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
    }

    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .panel-title {
      font-size: 15px;
      font-weight: 700;
    }

    form {
      padding: 16px;
      display: grid;
      gap: 14px;
    }

    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
      font-weight: 600;
    }

    input,
    textarea,
    select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 11px;
      color: var(--text);
      background: #fff;
      font: inherit;
      font-size: 14px;
      letter-spacing: 0;
    }

    textarea {
      min-height: 92px;
      resize: vertical;
      line-height: 1.45;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .field-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .field-row input {
      flex: 1;
    }

    button {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 9px 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: var(--primary);
      color: white;
    }

    button.secondary {
      background: #fff;
      color: var(--text);
      border-color: var(--line);
    }

    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    button:not(:disabled):hover {
      background: var(--primary-dark);
    }

    button.secondary:not(:disabled):hover {
      background: #eef2f7;
    }

    .workspace {
      min-height: calc(100vh - 96px);
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .tabs {
      display: flex;
      gap: 6px;
      padding: 10px 12px 0;
      border-bottom: 1px solid var(--line);
      overflow-x: auto;
    }

    .tab {
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      border-bottom: 0;
      border-radius: 6px 6px 0 0;
      padding: 9px 11px;
      white-space: nowrap;
    }

    .tab.active {
      color: var(--text);
      background: #fff;
      border-color: var(--line);
    }

    .tab:not(:disabled):hover {
      background: #eef2f7;
      color: var(--text);
    }

    .content {
      padding: 16px;
      overflow: auto;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f4f6fa;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 320px;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      letter-spacing: 0;
    }

    .execution-view {
      display: grid;
      gap: 12px;
      font-size: 13px;
      line-height: 1.5;
    }

    .execution-view[hidden] {
      display: none;
    }

    .execution-block,
    .execution-view details {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f4f6fa;
    }

    .execution-block {
      padding: 12px;
    }

    .execution-view summary {
      cursor: pointer;
      font-weight: 700;
      padding: 10px 12px;
      list-style-position: inside;
    }

    .execution-view details > div {
      padding: 0 12px 12px;
      display: grid;
      gap: 8px;
    }

    .kv {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 6px 10px;
    }

    .kv span:nth-child(odd) {
      color: var(--muted);
      font-weight: 700;
    }

    .mono-block {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }

    .artifact-row {
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }

    .status {
      min-height: 24px;
      font-size: 13px;
      color: var(--muted);
    }

    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.bad { color: var(--bad); }

    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      background: #fbfcff;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }

    .metric strong {
      font-size: 16px;
    }

    dialog {
      border: 1px solid var(--line);
      border-radius: 8px;
      width: min(620px, calc(100vw - 32px));
      padding: 0;
      box-shadow: 0 24px 60px rgba(15, 23, 42, .18);
    }

    dialog::backdrop {
      background: rgba(15, 23, 42, .32);
    }

    .modal-body {
      display: grid;
      gap: 12px;
      padding: 16px;
    }

    .project-list {
      display: grid;
      gap: 8px;
      max-height: 320px;
      overflow: auto;
    }

    .project-option {
      text-align: left;
      background: #fff;
      color: var(--text);
      border-color: var(--line);
      word-break: break-all;
    }

    .path-bar {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      background: #f4f6fa;
      word-break: break-all;
      font-size: 13px;
      min-height: 40px;
    }

    .directory-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      background: #fff;
      color: var(--text);
      border-color: var(--line);
      text-align: left;
      word-break: break-all;
    }

    @media (max-width: 900px) {
      header { padding: 0 16px; }
      main { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>AO Control Plane</h1>
    <div id="headerStatus" class="status">v${appVersion}</div>
  </header>

  <main>
    <section>
      <div class="panel-header">
        <div class="panel-title">需求输入</div>
      </div>
      <form id="requirementForm">
        <label>
          需求标题
          <input name="title" value="用户权限管理" required>
        </label>
        <label>
          历史草稿
          <div class="field-row">
            <select id="draftHistory">
              <option value="">暂无历史草稿</option>
            </select>
            <button id="deleteDraftButton" class="secondary" type="button" disabled>删除</button>
          </div>
        </label>
        <label>
          项目目录
          <div class="field-row">
            <input name="projectRoot" readonly placeholder="请选择项目目录">
            <button id="projectButton" class="secondary" type="button">选择</button>
          </div>
        </label>
        <label>
          需求描述
          <textarea name="description" required>为系统增加用户权限管理能力，支持按角色控制访问范围，并保留现有 API 响应格式。</textarea>
        </label>
        <label>
          讨论记录
          <textarea name="discussion">需要先完成设计审查，再拆解给 AO 内置角色执行。进入执行层后不能指定具体 agent。</textarea>
        </label>
        <label>
          验收标准，每行一条
          <textarea name="acceptanceCriteria">权限 API 按角色校验访问范围
未登录、权限不足、正常访问三类场景有测试
任务计划只包含 AO 内置角色</textarea>
        </label>
        <label>
          约束，每行一条
          <textarea name="constraints">不修改 AO core、CLI 或 Dashboard
执行任务中不出现 agent、model 或 provider 字段</textarea>
        </label>
        <label>
          最大设计审查轮次
          <input name="maxDesignReviewRounds" type="number" min="1" max="20" step="1" value="3">
        </label>
        <div class="actions">
          <button id="reviewButton" type="submit">生成需求设计并审查</button>
          <button id="rerunButton" class="secondary" type="submit">补充需求并重新审查</button>
          <button id="stopButton" class="secondary" type="button" disabled>停止</button>
          <button id="saveDraftButton" class="secondary" type="button">保存草稿</button>
          <button id="clearDraftButton" class="secondary" type="button">清空草稿</button>
          <button id="planButton" class="secondary" type="button" disabled>继续审查任务计划</button>
          <button id="executeButton" class="secondary" type="button" disabled>启动连续执行</button>
          <button id="retryExecutionTaskButton" class="secondary" type="button" disabled title="连续执行中断后，可重试当前失败任务。">重试任务</button>
          <button id="reconcileArtifactsButton" class="secondary" type="button" disabled title="任务产物缺失或冲突时，重新从 AO worktree 检查并归集控制面产物。">重新检查产物</button>
          <button id="markExecutionTaskCompletedButton" class="secondary" type="button" disabled title="任务中断后，人工把当前任务标记为已完成并继续。">人工标记完成</button>
          <button id="requestExecutionRevisionButton" class="secondary" type="button" disabled title="任务中断后，提交任务计划修订请求。">提交重规划请求</button>
          <button id="releaseManualGateButton" class="secondary" type="button" disabled title="manual_gate 等待时，人工批准门禁并继续执行。">门禁放行</button>
          <button id="dispatchManualGateReviewButton" class="secondary" type="button" disabled title="manual_gate 等待时，派发 AO reviewer 复核上下文产物。">派发门禁复核</button>
          <button id="replanManualGateButton" class="secondary" type="button" disabled title="manual_gate 等待时，要求先修复任务计划。">门禁要求重规划</button>
          <button id="blockManualGateButton" class="secondary" type="button" disabled title="manual_gate 等待时，标记该门禁阻断执行。">门禁标记阻断</button>
        </div>
        <div id="draftStatus" class="status">表单草稿会自动保存到本地。</div>
        <div id="formStatus" class="status"></div>
      </form>
    </section>

    <section class="workspace">
      <div>
        <div class="summary">
          <div class="metric"><span>Workflow</span><strong id="workflowId">未生成</strong></div>
          <div class="metric"><span>状态</span><strong id="workflowStatus">-</strong></div>
          <div class="metric"><span>审查轮次</span><strong id="reviewCount">0</strong></div>
          <div class="metric"><span>任务数量</span><strong id="taskCount">0</strong></div>
          <div class="metric"><span>已等待</span><strong id="elapsedSeconds">0s</strong></div>
        </div>
        <div class="tabs">
          <button class="tab active" type="button" data-tab="logs">过程</button>
          <button class="tab" type="button" data-tab="design">设计稿</button>
          <button class="tab" type="button" data-tab="reviews">审查</button>
          <button class="tab" type="button" data-tab="plan">任务计划</button>
          <button class="tab" type="button" data-tab="planReview">计划审查</button>
          <button class="tab" type="button" data-tab="execution">AO 执行</button>
        </div>
      </div>
      <div class="content">
        <pre id="output">填写需求后点击生成。</pre>
        <div id="executionDetails" class="execution-view" hidden></div>
      </div>
    </section>
  </main>

  <dialog id="projectDialog">
    <div class="panel-header">
      <div class="panel-title">选择项目目录</div>
      <button id="closeProjectDialog" class="secondary" type="button">关闭</button>
    </div>
    <div class="modal-body">
      <div class="path-bar" id="currentPath">选择一个磁盘或目录</div>
      <div class="actions">
        <button id="useCurrentPath" type="button" disabled>使用当前目录</button>
        <button id="parentPathButton" class="secondary" type="button" disabled>上一级</button>
      </div>
      <div class="status">历史目录</div>
      <div class="project-list" id="projectList"></div>
      <div class="status">本地目录</div>
      <div class="project-list" id="directoryList"></div>
    </div>
  </dialog>

  <script>
    const form = document.querySelector("#requirementForm");
    const output = document.querySelector("#output");
    const executionDetails = document.querySelector("#executionDetails");
    const formStatus = document.querySelector("#formStatus");
    const draftStatus = document.querySelector("#draftStatus");
    const draftHistory = document.querySelector("#draftHistory");
    const deleteDraftButton = document.querySelector("#deleteDraftButton");
    const reviewButton = document.querySelector("#reviewButton");
    const rerunButton = document.querySelector("#rerunButton");
    const stopButton = document.querySelector("#stopButton");
    const saveDraftButton = document.querySelector("#saveDraftButton");
    const clearDraftButton = document.querySelector("#clearDraftButton");
    const planButton = document.querySelector("#planButton");
    const executeButton = document.querySelector("#executeButton");
    const retryExecutionTaskButton = document.querySelector("#retryExecutionTaskButton");
    const reconcileArtifactsButton = document.querySelector("#reconcileArtifactsButton");
    const markExecutionTaskCompletedButton = document.querySelector("#markExecutionTaskCompletedButton");
    const requestExecutionRevisionButton = document.querySelector("#requestExecutionRevisionButton");
    const releaseManualGateButton = document.querySelector("#releaseManualGateButton");
    const dispatchManualGateReviewButton = document.querySelector("#dispatchManualGateReviewButton");
    const replanManualGateButton = document.querySelector("#replanManualGateButton");
    const blockManualGateButton = document.querySelector("#blockManualGateButton");
    const projectButton = document.querySelector("#projectButton");
    const projectDialog = document.querySelector("#projectDialog");
    const closeProjectDialog = document.querySelector("#closeProjectDialog");
    const useCurrentPath = document.querySelector("#useCurrentPath");
    const parentPathButton = document.querySelector("#parentPathButton");
    const projectList = document.querySelector("#projectList");
    const directoryList = document.querySelector("#directoryList");
    const currentPath = document.querySelector("#currentPath");
    const projectRootInput = document.querySelector('input[name="projectRoot"]');
    const state = {
      result: null,
      job: null,
      pollTimer: null,
      localTimer: null,
      execution: null,
      executionPollTimer: null,
      activeTab: "logs",
      pendingRender: false,
      browsingPath: "",
      workflowId: "",
      draftSaveTimer: null,
      requirementDrafts: []
    };

    loadProjects();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await runStep(
        "/api/governance/run",
        "正在执行完整治理流程：Codex 生成设计和任务计划，ClaudeCode 审查，Codex 根据意见整改...",
        "后台任务已结束。若补充需求后重新审查，审查轮次会从 1 开始。",
        "logs"
      );
    });

    form.addEventListener("input", () => scheduleDraftSave());
    form.addEventListener("change", () => scheduleDraftSave());

    draftHistory.addEventListener("change", async () => {
      const selected = state.requirementDrafts[Number(draftHistory.value)];
      if (!selected) return;
      await restoreDraft(selected);
    });

    deleteDraftButton.addEventListener("click", async () => {
      const selected = state.requirementDrafts[Number(draftHistory.value)];
      if (!selected?.draftKey) return;
      try {
        const response = await fetch("/api/governance/drafts/" + encodeURIComponent(selected.draftKey), {
          method: "DELETE"
        });
        const config = await readResponse(response);
        if (isSameDraft(selected, { workflowId: state.workflowId, title: String(form.elements.title.value || ""), description: String(form.elements.description.value || "") })) {
          state.workflowId = "";
        }
        renderDraftHistory(config.requirementDrafts || []);
        await restoreDraft(config.requirementDraft || config.requirementDrafts?.[0]);
        setDraftStatus("warn", "已删除所选历史草稿。");
      } catch (error) {
        setDraftStatus("bad", error.message || String(error));
      }
    });

    saveDraftButton.addEventListener("click", async () => {
      try {
        await saveDraft();
        setDraftStatus("ok", "需求草稿已保存。");
      } catch (error) {
        setDraftStatus("bad", error.message || String(error));
      }
    });

    projectButton.addEventListener("click", async () => {
      projectDialog.showModal();
      await browseDirectories(projectRootInput.value);
    });
    closeProjectDialog.addEventListener("click", () => projectDialog.close());
    useCurrentPath.addEventListener("click", async () => {
      if (!state.browsingPath) return;
      await selectProjectRoot(state.browsingPath);
      projectDialog.close();
    });
    parentPathButton.addEventListener("click", async () => {
      const parentPath = parentPathButton.dataset.path;
      if (parentPath) await browseDirectories(parentPath);
    });

    stopButton.addEventListener("click", async () => {
      if (!state.job?.jobId) return;
      try {
        const response = await fetch("/api/governance/jobs/" + encodeURIComponent(state.job.jobId) + "/stop", {
          method: "POST"
        });
        state.job = await readResponse(response);
        stopPollingTimers();
        updateSummary();
        renderActiveTab();
        setStatus("warn", "已停止当前治理流程。");
      } catch (error) {
        setStatus("bad", error.message || String(error));
      }
    });

    clearDraftButton.addEventListener("click", async () => {
      try {
        const response = await fetch("/api/governance/draft", { method: "DELETE" });
        const config = await readResponse(response);
        state.workflowId = "";
        state.result = null;
        state.execution = null;
        renderDraftHistory(config.requirementDrafts || []);
        updateSummary();
        renderActiveTab();
        setDraftStatus("warn", "需求草稿已清空。");
        setStatus("ok", "需求草稿已清空。");
      } catch (error) {
        setStatus("bad", error.message || String(error));
      }
    });

    planButton.addEventListener("click", async () => {
      const workflowId = state.result?.workflow?.workflowId || state.workflowId;
      if (!workflowId) return;
      setBusy(true, "正在生成并审查任务计划...");
      let startedJob = false;
      try {
        const response = await fetch("/api/governance/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowId,
            projectRoot: getProjectRoot(),
            maxDesignReviewRounds: Number(new FormData(form).get("maxDesignReviewRounds") || 3)
          })
        });
        const responseBody = await readResponse(response);
        if (responseBody.jobId) {
          startedJob = true;
          state.job = responseBody;
          state.result = null;
          state.activeTab = "logs";
          activateTab("logs");
          updateSummary();
          renderActiveTab();
          startPollingJob(responseBody.jobId, "任务计划审查已完成。");
          return;
        }
        state.result = responseBody;
        state.activeTab = "plan";
        activateTab("plan");
        updateSummary();
        renderActiveTab();
        setStatus("ok", "任务计划已生成。");
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        if (!startedJob) {
          setBusy(false);
        }
      }
    });

    executeButton.addEventListener("click", async () => {
      if (!confirm("即将启动连续执行，调度器会按任务顺序和依赖关系持续派发 AO 任务，是否继续？")) return;
      await startContinuousExecution("正在启动连续执行...");
    });

    retryExecutionTaskButton.addEventListener("click", async () => {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return;
      if (!confirm("确认重试当前任务 " + taskId + "？调度器会重新派发该任务。")) return;
      await submitExecutionRecovery("retry", "正在重试任务...");
    });

    reconcileArtifactsButton.addEventListener("click", async () => {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return;
      await reconcileArtifacts("正在重新检查 AO worktree 产物...");
    });

    markExecutionTaskCompletedButton.addEventListener("click", async () => {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return;
      const rationale = prompt("请输入人工标记完成原因，调度器会把当前任务置为完成并继续后续任务。", "已人工核验任务结果符合验收标准");
      if (!rationale || !rationale.trim()) return;
      await submitExecutionRecovery("mark-completed", "正在人工标记任务完成...", rationale.trim());
    });

    requestExecutionRevisionButton.addEventListener("click", async () => {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return;
      const rationale = prompt("请输入重规划请求原因，系统会基于当前失败点修复任务计划。", getDefaultRevisionRationale());
      if (!rationale || !rationale.trim()) return;
      await submitExecutionRecovery("request-revision", "正在提交重规划请求...", rationale.trim());
    });

    releaseManualGateButton.addEventListener("click", async () => {
      if (!confirm("确认人工批准当前门禁并继续执行？该动作不会调用 AO，会由控制平面生成门禁产物。")) return;
      await approveManualGate("Web UI 门禁放行");
    });

    dispatchManualGateReviewButton.addEventListener("click", async () => {
      if (!confirm("确认派发 AO reviewer 复核当前门禁？该动作会调用 AO，并要求 AO 读取控制平面上下文产物。")) return;
      await dispatchManualGateReview("Web UI 派发门禁复核");
    });

    replanManualGateButton.addEventListener("click", async () => {
      if (!confirm("确认当前 manual_gate 要求先修复任务计划？连续执行会暂停到重规划流程。")) return;
      await submitManualGateDecision("requires_replan", "Web UI 门禁要求重规划");
    });

    blockManualGateButton.addEventListener("click", async () => {
      if (!confirm("确认将当前 manual_gate 标记为阻断？连续执行会中断。")) return;
      await submitManualGateDecision("blocked", "Web UI 门禁标记阻断");
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.activeTab = tab.dataset.tab;
        activateTab(state.activeTab);
        renderActiveTab();
      });
    });

    document.addEventListener("selectionchange", () => {
      if (!state.pendingRender || outputHasSelection()) return;
      state.pendingRender = false;
      renderActiveTab();
    });

    document.addEventListener("visibilitychange", () => {
      if (!state.job || state.job.status !== "running") return;
      if (document.hidden) {
        stopPollingTimers();
      } else {
        startPollingJob(state.job.jobId, "后台任务已结束。若补充需求后重新审查，审查轮次会从 1 开始。");
      }
    });

    async function runStep(path, busyMessage, successMessage, nextTab) {
      setBusy(true, busyMessage);
      state.execution = null;
      let startedJob = false;
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildGovernancePayload())
        });
        const responseBody = await readResponse(response);
        if (responseBody.jobId) {
          startedJob = true;
          state.job = responseBody;
          state.result = null;
          state.activeTab = nextTab;
          activateTab(nextTab);
          updateSummary();
          renderActiveTab();
          startPollingJob(responseBody.jobId, successMessage);
          return;
        }
        state.result = responseBody;
        rememberWorkflowIdFromResult(responseBody);
        state.activeTab = nextTab;
        activateTab(nextTab);
        updateSummary();
        renderActiveTab();
        setStatus("ok", successMessage + " " + state.result.artifactDir);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        if (!startedJob) {
          setBusy(false);
        }
      }
    }

    function startPollingJob(jobId, successMessage) {
      stopPollingTimers();
      pollJob(jobId, successMessage);
      state.pollTimer = setInterval(() => pollJob(jobId, successMessage), 1500);
      state.localTimer = setInterval(() => {
        if (state.job?.status === "running") {
          state.job.elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - new Date(state.job.startedAt).getTime()) / 1000)
          );
          updateSummary();
          if (state.activeTab === "logs") renderActiveTab();
        }
      }, 1000);
    }

    function stopPollingTimers() {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      if (state.localTimer) {
        clearInterval(state.localTimer);
        state.localTimer = null;
      }
      if (state.executionPollTimer) {
        clearInterval(state.executionPollTimer);
        state.executionPollTimer = null;
      }
    }

    async function pollJob(jobId, successMessage) {
      try {
        const response = await fetch("/api/governance/jobs/" + encodeURIComponent(jobId));
        const job = await readResponse(response);
        if (state.job?.jobId !== job.jobId) return;
        state.job = job;
        if (job.result) state.result = job.result;
        if (job.result) rememberWorkflowIdFromResult(job.result);
        updateSummary();
        renderActiveTab();
        if (job.status === "completed" || job.status === "failed") {
          stopPollingTimers();
          setBusy(false);
          setStatus(job.status === "completed" ? "ok" : "bad", job.status === "completed" ? getCompletedJobMessage(job, successMessage) : job.error || "流程失败。");
        }
        if (job.status === "stopped") {
          stopPollingTimers();
          setBusy(false);
          setStatus("warn", "已停止当前治理流程。");
        }
      } catch (error) {
        stopPollingTimers();
        setBusy(false);
        setStatus("bad", error.message || String(error));
      }
    }

    function getCompletedJobMessage(job, fallbackMessage) {
      if (job.result?.workflow?.status === "blocked_for_human") {
        return "审查轮次已用完，仍存在设计阶段未解决问题，等待人工补充或提高轮次后继续。";
      }
      const reviews = job.result?.reviews || job.reviews || [];
      const finalReview = reviews[reviews.length - 1];
      if (finalReview?.reviewDecision === "defer_to_implementation") {
        return "设计已达到可实施标准，部分问题将进入实施阶段处理。";
      }
      if (job.result?.plan) {
        return fallbackMessage;
      }
      return "后台任务已结束。";
    }

    async function loadProjects() {
      try {
        const response = await fetch("/api/projects");
        const config = await readResponse(response);
        renderProjects(config);
        renderDraftHistory(config.requirementDrafts || []);
        if (config.selectedProjectRoot) {
          projectRootInput.value = config.selectedProjectRoot;
        }
        await restoreDraft(config.requirementDraft);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      }
    }

    async function browseDirectories(path) {
      const query = path ? "?path=" + encodeURIComponent(path) : "";
      const response = await fetch("/api/filesystem/browse" + query);
      const listing = await readResponse(response);
      state.browsingPath = listing.currentPath || "";
      currentPath.textContent = listing.currentPath || "选择一个磁盘或目录";
      useCurrentPath.disabled = !listing.currentPath;
      parentPathButton.disabled = !listing.parentPath;
      parentPathButton.dataset.path = listing.parentPath || "";
      renderDirectories(listing);
    }

    async function selectProjectRoot(projectRoot) {
      const response = await fetch("/api/projects/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot })
      });
      const config = await readResponse(response);
      projectRootInput.value = config.selectedProjectRoot || projectRoot;
      renderProjects(config);
      renderDraftHistory(config.requirementDrafts || []);
    }

    function renderProjects(config) {
      const roots = config.recentProjectRoots || [];
      projectList.innerHTML = "";
      if (roots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "status";
        empty.textContent = "暂无历史目录。";
        projectList.appendChild(empty);
        return;
      }

      roots.forEach((root) => {
        const button = document.createElement("button");
        button.className = "project-option";
        button.type = "button";
        button.textContent = root;
        button.addEventListener("click", async () => {
          await selectProjectRoot(root);
          projectDialog.close();
        });
        projectList.appendChild(button);
      });
    }

    function renderDirectories(listing) {
      directoryList.innerHTML = "";
      const entries = listing.currentPath ? listing.directories || [] : listing.roots || [];
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "status";
        empty.textContent = listing.currentPath ? "当前目录没有可进入的子目录。" : "未找到可用磁盘。";
        directoryList.appendChild(empty);
        return;
      }

      entries.forEach((entry) => {
        const button = document.createElement("button");
        button.className = "directory-row";
        button.type = "button";
        button.textContent = entry.name;
        button.addEventListener("click", async () => {
          await browseDirectories(entry.path);
        });
        directoryList.appendChild(button);
      });
    }

    function renderDraftHistory(drafts) {
      state.requirementDrafts = drafts || [];
      draftHistory.innerHTML = "";
      if (!state.requirementDrafts.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "暂无历史草稿";
        draftHistory.appendChild(option);
        draftHistory.disabled = true;
        deleteDraftButton.disabled = true;
        return;
      }

      draftHistory.disabled = false;
      deleteDraftButton.disabled = false;
      state.requirementDrafts.forEach((draft, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = formatDraftLabel(draft);
        draftHistory.appendChild(option);
      });
    }

    function formatDraftLabel(draft) {
      const title = draft.title || "未命名需求";
      const workflow = draft.workflowId ? " / " + draft.workflowId : "";
      const updatedAt = draft.updatedAt ? " / " + draft.updatedAt : "";
      return title + workflow + updatedAt;
    }

    function buildGovernancePayload() {
      const formData = new FormData(form);
      return {
        projectRoot: getProjectRoot(),
        workflowId: state.workflowId || state.result?.workflow?.workflowId,
        title: String(formData.get("title") || ""),
        description: String(formData.get("description") || ""),
        discussion: String(formData.get("discussion") || ""),
        acceptanceCriteria: splitLines(String(formData.get("acceptanceCriteria") || "")),
        constraints: splitLines(String(formData.get("constraints") || "")),
        maxDesignReviewRounds: Number(formData.get("maxDesignReviewRounds") || 3)
      };
    }

    function getProjectRoot() {
      return String(new FormData(form).get("projectRoot") || "").trim();
    }

    function splitLines(value) {
      return value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
    }

    function scheduleDraftSave() {
      if (state.draftSaveTimer) clearTimeout(state.draftSaveTimer);
      state.draftSaveTimer = setTimeout(() => {
        state.draftSaveTimer = null;
        saveDraft()
          .then(() => setDraftStatus("ok", "需求草稿已自动保存。"))
          .catch((error) => setDraftStatus("bad", error.message || String(error)));
      }, 600);
    }

    async function saveDraft() {
      const payload = buildGovernancePayload();
      if (!payload.title && !payload.description && !payload.discussion) return;
      const response = await fetch("/api/governance/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const config = await readResponse(response);
      renderDraftHistory(config.requirementDrafts || []);
    }

    async function restoreDraft(draft) {
      if (!draft) {
        state.workflowId = "";
        state.result = null;
        state.execution = null;
        updateSummary();
        renderActiveTab();
        return;
      }
      state.workflowId = draft.workflowId || "";
      state.result = null;
      state.execution = null;
      setFieldValue("title", draft.title);
      setFieldValue("projectRoot", draft.projectRoot || projectRootInput.value);
      setFieldValue("description", draft.description);
      setFieldValue("discussion", draft.discussion || "");
      setFieldValue("acceptanceCriteria", draft.acceptanceCriteria || "");
      setFieldValue("constraints", draft.constraints || "");
      setFieldValue("maxDesignReviewRounds", String(draft.maxDesignReviewRounds || 3));
      selectDraftInHistory(draft);
      updateSummary();
      renderActiveTab();
      setDraftStatus("ok", "已恢复上次需求草稿" + (draft.updatedAt ? "，保存时间：" + draft.updatedAt : "") + "。");
      setStatus("ok", "已恢复上次需求草稿。");
      await loadWorkflowSnapshot(draft);
    }

    async function loadWorkflowSnapshot(draft) {
      const workflowId = draft?.workflowId || state.workflowId;
      if (!workflowId) return;
      const projectRoot = String(draft.projectRoot || projectRootInput.value || "").trim();
      const query = projectRoot ? "?projectRoot=" + encodeURIComponent(projectRoot) : "";
      try {
        const response = await fetch("/api/governance/workflows/" + encodeURIComponent(workflowId) + query);
        state.result = await readResponse(response);
        state.job = null;
        updateSummary();
        renderActiveTab();
        await loadExecutionSnapshot(workflowId, projectRoot, false);
      } catch (error) {
        state.result = null;
        updateSummary();
        setStatus("warn", "已恢复需求草稿，但未读取到已生成的工作流产物：" + (error.message || String(error)));
      }
    }

    function selectDraftInHistory(draft) {
      const key = getClientDraftKey(draft);
      const index = state.requirementDrafts.findIndex((item) => {
        return getClientDraftKey(item) === key;
      });
      if (index >= 0) {
        draftHistory.value = String(index);
      }
    }

    function isSameDraft(left, right) {
      return getClientDraftKey(left) === getClientDraftKey(right);
    }

    function getClientDraftKey(draft) {
      if (draft.draftKey) return draft.draftKey;
      if (draft.workflowId) return "workflow:" + draft.workflowId;
      return "draft:" + String(draft.title || "").trim().toLowerCase();
    }

    function setFieldValue(name, value) {
      const field = form.elements[name];
      if (field && value !== undefined) field.value = value;
    }

    function rememberWorkflowIdFromResult(result) {
      const workflowId = result?.workflow?.workflowId;
      if (!workflowId) return;
      state.workflowId = workflowId;
      saveDraft().catch((error) => setDraftStatus("bad", error.message || String(error)));
    }

    async function readResponse(response) {
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "请求失败");
      }
      return json;
    }

    function setBusy(busy, message = "") {
      reviewButton.disabled = busy;
      rerunButton.disabled = false;
      stopButton.disabled = !busy;
      saveDraftButton.disabled = busy;
      deleteDraftButton.disabled = busy || !state.requirementDrafts.length;
      planButton.disabled = busy || !canReviewTaskPlan(state.result);
      planButton.title = getPlanButtonTitle(busy, state.result);
      executeButton.disabled = busy || !canStartContinuousExecution();
      retryExecutionTaskButton.disabled = busy || !canRetryExecutionTask();
      retryExecutionTaskButton.title = getExecutionRecoveryButtonTitle("retry");
      reconcileArtifactsButton.disabled = busy || !canReconcileArtifacts();
      reconcileArtifactsButton.title = getReconcileArtifactsButtonTitle();
      markExecutionTaskCompletedButton.disabled = busy || !canRecoverExecutionTask();
      markExecutionTaskCompletedButton.title = getExecutionRecoveryButtonTitle("mark-completed");
      requestExecutionRevisionButton.disabled = busy || !canRecoverExecutionTask();
      requestExecutionRevisionButton.title = getExecutionRecoveryButtonTitle("request-revision");
      releaseManualGateButton.disabled = busy || getManualGateBlockedTaskIds().length === 0;
      releaseManualGateButton.title = getReleaseManualGateButtonTitle();
      dispatchManualGateReviewButton.disabled = busy || !canDispatchManualGateReview();
      dispatchManualGateReviewButton.title = getDispatchManualGateReviewButtonTitle();
      replanManualGateButton.disabled = busy || getManualGateBlockedTaskIds().length === 0;
      replanManualGateButton.title = getManualGateDecisionButtonTitle("requires_replan");
      blockManualGateButton.disabled = busy || getManualGateBlockedTaskIds().length === 0;
      blockManualGateButton.title = getManualGateDecisionButtonTitle("blocked");
      clearDraftButton.disabled = busy;
      if (message) setStatus("warn", message);
    }

    function setStatus(kind, message) {
      formStatus.className = "status " + kind;
      formStatus.textContent = message;
    }

    function setDraftStatus(kind, message) {
      draftStatus.className = "status " + kind;
      draftStatus.textContent = message;
    }

    function activateTab(tabName) {
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === tabName);
      });
    }

    function updateSummary() {
      const result = state.result;
      const job = state.job;
      const running = job?.status === "running";
      const executionRunning = ["running", "waiting_manual_gate", "paused_for_replan"].includes(state.execution?.status);
      document.querySelector("#workflowId").textContent = result?.workflow?.workflowId || job?.result?.workflow?.workflowId || state.workflowId || "未生成";
      document.querySelector("#workflowStatus").textContent = job?.currentStep || (state.execution ? "连续执行：" + state.execution.status : "") || result?.workflow?.status || job?.status || "-";
      document.querySelector("#reviewCount").textContent = String(result?.reviews?.length || job?.reviews?.length || 0);
      document.querySelector("#taskCount").textContent = formatTaskCount();
      document.querySelector("#elapsedSeconds").textContent = String(job?.elapsedSeconds || 0) + "s";
      reviewButton.disabled = running;
      rerunButton.disabled = false;
      stopButton.disabled = !running;
      saveDraftButton.disabled = running;
      clearDraftButton.disabled = running;
      deleteDraftButton.disabled = running || !state.requirementDrafts.length;
      planButton.disabled = running || !canReviewTaskPlan(result);
      planButton.title = getPlanButtonTitle(running, result);
      executeButton.disabled = running || executionRunning || !canStartContinuousExecution();
      retryExecutionTaskButton.disabled = running || !canRetryExecutionTask();
      retryExecutionTaskButton.title = getExecutionRecoveryButtonTitle("retry");
      reconcileArtifactsButton.disabled = running || !canReconcileArtifacts();
      reconcileArtifactsButton.title = getReconcileArtifactsButtonTitle();
      markExecutionTaskCompletedButton.disabled = running || !canRecoverExecutionTask();
      markExecutionTaskCompletedButton.title = getExecutionRecoveryButtonTitle("mark-completed");
      requestExecutionRevisionButton.disabled = running || !canRecoverExecutionTask();
      requestExecutionRevisionButton.title = getExecutionRecoveryButtonTitle("request-revision");
      releaseManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      releaseManualGateButton.title = getReleaseManualGateButtonTitle();
      dispatchManualGateReviewButton.disabled = running || !canDispatchManualGateReview();
      dispatchManualGateReviewButton.title = getDispatchManualGateReviewButtonTitle();
      replanManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      replanManualGateButton.title = getManualGateDecisionButtonTitle("requires_replan");
      blockManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      blockManualGateButton.title = getManualGateDecisionButtonTitle("blocked");
    }

    function canReviewTaskPlan(result) {
      const workflowStatus = result?.workflow?.status;
      return workflowStatus === "ready_for_planning" || Boolean(result?.plan) || Boolean(state.workflowId);
    }

    function canStartContinuousExecution() {
      if (state.execution && ["running", "waiting_manual_gate", "paused_for_replan", "failed", "completed"].includes(state.execution.status)) {
        return false;
      }
      if (state.result?.workflow?.status === "executing" && state.result?.plan) {
        return true;
      }
      return Boolean(state.workflowId && state.result?.plan);
    }

    function getPlanButtonTitle(running, result) {
      const workflowStatus = result?.workflow?.status;
      if (running) return "治理流程运行中，暂不能单独生成任务计划。";
      if (workflowStatus === "ready_for_planning") return "设计审查已通过，可以生成并审查任务计划。";
      if (result?.plan && workflowStatus === "executing") return "已有任务计划，可以基于当前计划继续审查或整改。";
      if (result?.plan && workflowStatus === "blocked_for_human") return "已有任务计划草稿，可以基于当前计划继续审查或整改。";
      if (!result && state.workflowId) return "已恢复历史需求，可尝试基于已保存任务计划继续审查或整改。";
      if (workflowStatus === "blocked_for_human") return "当前仍需人工补充或复核，且没有可继续的任务计划。";
      return "需先完成分阶段设计审查。";
    }

    function renderActiveTab() {
      if (outputHasSelection()) {
        state.pendingRender = true;
        return;
      }
      state.pendingRender = false;

      if (!state.result && !state.job) {
        if (state.execution) {
          renderExecutionTabContent();
          return;
        }
        renderTextContent("填写需求后点击生成。");
        return;
      }

      if (state.activeTab === "logs") {
        const timer = state.job ? ["当前步骤：" + state.job.currentStep, "已等待：" + state.job.elapsedSeconds + " 秒", ""].join("\\n") : "";
        renderTextContent(timer + ((state.job?.logs || []).join("\\n") || "等待流程开始。"));
      } else if (state.activeTab === "design") {
        renderTextContent(state.job?.design?.content || state.result?.design || "");
      } else if (state.activeTab === "reviews") {
        const reviews = state.job?.reviews || state.result?.reviews || [];
        if (state.job?.reviews?.length) {
          renderTextContent(JSON.stringify(reviews[reviews.length - 1] || null, null, 2));
        } else {
          renderTextContent(JSON.stringify(reviews, null, 2));
        }
      } else if (state.activeTab === "plan") {
        renderTextContent(formatPlanTabContent());
      } else if (state.activeTab === "planReview") {
        renderTextContent(formatPlanReviewTabContent());
      } else {
        renderExecutionTabContent();
      }
    }

    function renderTextContent(text) {
      executionDetails.hidden = true;
      executionDetails.replaceChildren();
      output.hidden = false;
      output.textContent = text;
    }

    function renderExecutionTabContent() {
      if (!state.execution) {
        renderTextContent(JSON.stringify({ message: "尚未启动连续执行。" }, null, 2));
        return;
      }
      output.hidden = true;
      output.textContent = "";
      executionDetails.hidden = false;
      executionDetails.replaceChildren();
      executionDetails.appendChild(buildExecutionOverview(state.execution));
      if (state.execution.artifactDiagnostics) {
        executionDetails.appendChild(buildArtifactDiagnosticsDetails(state.execution.artifactDiagnostics, state.execution));
      }
      if (state.execution.manualGateContext) {
        executionDetails.appendChild(buildTextDetails("门禁上下文", formatManualGateContext(state.execution.manualGateContext), state.execution.status === "waiting_manual_gate"));
      }
      executionDetails.appendChild(buildTextDetails("过程日志", formatExecutionLogs(state.execution), true));
      executionDetails.appendChild(buildTextDetails("原始快照", JSON.stringify(state.execution, null, 2), false));
    }

    function buildExecutionOverview(execution) {
      const summary = execution.summary || {};
      const activeTask = execution.activeTask || {};
      const block = document.createElement("div");
      block.className = "execution-block";
      const rows = [
        ["连续执行状态", execution.status + (execution.readonly ? "（只读挂载）" : "")],
        ["Workflow", execution.workflowId || "-"],
        ["Job", execution.jobId || "-"],
        ["任务统计", "完成 " + Number(summary.completed || 0) + "，执行中 " + Number(summary.working || 0) + "，待执行 " + Number(summary.pending || 0) + "，阻断 " + Number(summary.blocked || 0) + "，失败 " + Number(summary.failed || 0)]
      ];
      if (activeTask.taskId) {
        rows.push(
          ["当前任务", activeTask.taskId + " / " + (activeTask.title || "未命名任务")],
          ["任务状态", activeTask.status || "-"],
          ["AO 角色", activeTask.aoRole || "-"],
          ["AO session", activeTask.aoSessionId || "尚未拿到 sessionId，正在按任务前缀从 AO 会话列表追踪"],
          ["尝试次数", Number(activeTask.attempt || 0) + "（不限）"]
        );
        const latestObservation = (activeTask.statusObservations || []).at(-1);
        if (latestObservation) {
          rows.push(["最近 AO 状态", latestObservation.status + " / " + latestObservation.observedAt]);
        }
      } else {
        rows.push(["当前任务", "暂无，调度器正在等待可执行任务或终态。"]);
      }
      if (execution.failure) {
        rows.push(["失败信息", execution.failure.kind + " / " + execution.failure.message]);
      }
      block.appendChild(buildKeyValueRows(rows));
      return block;
    }

    function buildArtifactDiagnosticsDetails(diagnostics, execution) {
      const missingCount = (diagnostics.missingArtifacts || []).length;
      const shouldOpen = execution.status === "failed" || missingCount > 0 || Boolean(diagnostics.latestReconcile);
      const details = document.createElement("details");
      details.open = shouldOpen;
      const summary = document.createElement("summary");
      summary.textContent = "产物诊断：" + (diagnostics.taskId || "-") + "，契约 " + (diagnostics.contracts || []).length + "，缺失 " + missingCount;
      details.appendChild(summary);
      const body = document.createElement("div");
      const contracts = diagnostics.contracts || [];
      if (contracts.length === 0) {
        body.appendChild(textBlock("当前任务没有注册表控制面产物。"));
      }
      contracts.forEach((contract) => {
        const contractDetails = document.createElement("details");
        contractDetails.className = "artifact-row";
        contractDetails.open = !contract.canonicalExists || missingCount > 0;
        const contractSummary = document.createElement("summary");
        contractSummary.textContent = contract.contractId + "：" + (contract.canonicalExists ? "canonical 已存在" : "canonical 缺失");
        contractDetails.appendChild(contractSummary);
        const contractBody = document.createElement("div");
        contractBody.appendChild(buildKeyValueRows([
          ["kind", contract.kind],
          ["canonical", contract.canonicalPath],
          ["required", contract.requiredWhen ? "requiredWhen=" + contract.requiredWhen : String(Boolean(contract.required))]
        ]));
        const candidates = (contract.candidatePaths || []).slice(0, 8);
        if (candidates.length > 0) {
          contractBody.appendChild(textBlock("候选路径：\\n" + candidates.map((candidate) =>
            "- " + candidate.source + "/" + candidate.purpose + " priority=" + candidate.priority + "\\n  " + candidate.path
          ).join("\\n")));
        }
        contractDetails.appendChild(contractBody);
        body.appendChild(contractDetails);
      });
      if (missingCount > 0) {
        body.appendChild(textBlock("缺失 required 产物：\\n" + diagnostics.missingArtifacts.map((artifact) => "- " + artifact.kind + "：" + artifact.path).join("\\n")));
      }
      if (diagnostics.latestReconcile) {
        body.appendChild(buildTextDetails("最近归集事件", JSON.stringify(diagnostics.latestReconcile, null, 2), true));
      }
      details.appendChild(body);
      return details;
    }

    function buildTextDetails(title, text, open) {
      const details = document.createElement("details");
      details.open = Boolean(open);
      const summary = document.createElement("summary");
      summary.textContent = title;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.appendChild(textBlock(text || "-"));
      details.appendChild(body);
      return details;
    }

    function buildKeyValueRows(rows) {
      const container = document.createElement("div");
      container.className = "kv";
      rows.forEach(([key, value]) => {
        const keyNode = document.createElement("span");
        keyNode.textContent = key;
        const valueNode = document.createElement("span");
        valueNode.textContent = value ?? "-";
        container.appendChild(keyNode);
        container.appendChild(valueNode);
      });
      return container;
    }

    function textBlock(text) {
      const node = document.createElement("div");
      node.className = "mono-block";
      node.textContent = text;
      return node;
    }

    function formatExecutionLogs(execution) {
      const logs = execution.logs || [];
      if (logs.length === 0) {
        return "暂无执行日志。";
      }
      return logs.slice(-20).map((event) => formatExecutionEvent(event)).join("\\n");
    }

    function formatExecutionTabContent() {
      if (!state.execution) {
        return JSON.stringify({ message: "尚未启动连续执行。" }, null, 2);
      }
      const execution = state.execution;
      const summary = execution.summary || {};
      const activeTask = execution.activeTask || {};
      const lines = [
        "连续执行状态：" + execution.status + (execution.readonly ? "（只读挂载）" : ""),
        "Workflow：" + execution.workflowId,
        "Job：" + execution.jobId,
        "任务统计：完成 " + Number(summary.completed || 0) +
          "，执行中 " + Number(summary.working || 0) +
          "，待执行 " + Number(summary.pending || 0) +
          "，阻断 " + Number(summary.blocked || 0) +
          "，失败 " + Number(summary.failed || 0),
        ""
      ];
      if (execution.status === "failed") {
        lines.push("已中断，需要人工处理：请根据现场情况选择“重试任务”“人工标记完成”或“提交重规划请求”。", "");
      } else if (execution.status === "paused_for_replan") {
        lines.push("已暂停等待重规划：可点击“提交重规划请求”修复任务计划。", "");
      } else if (execution.status === "waiting_manual_gate") {
        lines.push("等待门禁复核：调度器会在继续执行时自动派发 AO reviewer；仅在 AO 无法解决、证据缺失或反复阻断时需要人工处理。", "");
      }
      if (activeTask.taskId) {
        lines.push(
          "当前任务：" + activeTask.taskId + " / " + (activeTask.title || "未命名任务"),
          "任务状态：" + activeTask.status,
          "AO 角色：" + (activeTask.aoRole || "-"),
          "AO session：" + (activeTask.aoSessionId || "尚未拿到 sessionId，正在按任务前缀从 AO 会话列表追踪"),
          "尝试次数：" + Number(activeTask.attempt || 0) + "（不限）"
        );
        const latestObservation = (activeTask.statusObservations || []).at(-1);
        if (latestObservation) {
          lines.push("最近 AO 状态：" + latestObservation.status + " / " + latestObservation.observedAt);
        }
      } else {
        lines.push("当前任务：暂无，调度器正在等待可执行任务或终态。");
      }
      if (execution.failure) {
        lines.push("", "失败信息：" + execution.failure.kind + " / " + execution.failure.message);
      }
      if (execution.artifactDiagnostics) {
        lines.push("", formatArtifactDiagnostics(execution.artifactDiagnostics));
      }
      if (execution.manualGateContext) {
        lines.push("", formatManualGateContext(execution.manualGateContext));
      }
      const latestManualGateRelease = (execution.manualGateReleases || []).filter((release) => (release.generatedArtifacts || []).length > 0).at(-1);
      if (latestManualGateRelease) {
        lines.push(
          "",
          "最近门禁产物：" + latestManualGateRelease.taskId,
          ...(latestManualGateRelease.generatedArtifacts || []).map((artifact) => "- " + artifact)
        );
      }
      lines.push("", "过程日志：");
      const logs = execution.logs || [];
      if (logs.length === 0) {
        lines.push("暂无执行日志。");
      } else {
        logs.slice(-20).forEach((event) => lines.push(formatExecutionEvent(event)));
      }
      lines.push("", "原始快照：", JSON.stringify(execution, null, 2));
      const waitingScheduler =
        execution.status === "running" &&
        !execution.currentTaskId &&
        Number(summary.working || 0) > 0;
      if (waitingScheduler) {
        lines.unshift("迁移完成，等待调度器选择下一个任务。", "");
      }
      return lines.join("\\n");
    }

    function formatExecutionEvent(event) {
      if (!event || typeof event !== "object") return String(event);
      const parts = [
        event.at || "-",
        event.type || "event",
        event.taskId ? "task=" + event.taskId : "",
        event.aoSessionId ? "aoSession=" + event.aoSessionId : "",
        event.actor ? "actor=" + event.actor : ""
      ].filter(Boolean);
      const details = [];
      if (event.type === "artifact_output_reconcile_started") {
        details.push("开始检查 canonical 产物与 AO worktree 候选。");
      }
      if (event.recovered) {
        details.push("from=" + event.recovered.from);
        details.push("to=" + event.recovered.to);
        if (event.recovered.normalized) details.push("已归一化 AO review 元数据");
      }
      if (event.skipped) {
        details.push("skip=" + event.skipped.reason);
        if (event.skipped.detail) details.push(event.skipped.detail);
      }
      if (event.failures) {
        details.push("failures=" + formatArtifactEventDetails(event.failures));
      }
      if (event.conflicts) {
        details.push("conflicts=" + formatArtifactEventDetails(event.conflicts));
      }
      if (event.missing) {
        details.push("missing=" + formatArtifactEventDetails(event.missing));
      }
      return parts.join(" | ") + (details.length ? " | " + details.join(" | ") : "");
    }

    function formatArtifactDiagnostics(diagnostics) {
      const lines = ["产物诊断：" + (diagnostics.taskId || "-")];
      const contracts = diagnostics.contracts || [];
      if (contracts.length === 0) {
        lines.push("- 当前任务没有注册表控制面产物。");
      }
      contracts.forEach((contract) => {
        lines.push(
          "- " + contract.contractId + "：" +
          (contract.canonicalExists ? "canonical 已存在" : "canonical 缺失") +
          "，路径 " + contract.canonicalPath
        );
        (contract.candidatePaths || []).slice(0, 5).forEach((candidate) => {
          lines.push("  候选 " + candidate.source + "/" + candidate.purpose + "：" + candidate.path);
        });
      });
      if ((diagnostics.missingArtifacts || []).length > 0) {
        lines.push("缺失 required 产物：");
        diagnostics.missingArtifacts.forEach((artifact) => {
          lines.push("- " + artifact.kind + "：" + artifact.path);
        });
      }
      if (diagnostics.latestReconcile) {
        lines.push("最近归集事件：" + JSON.stringify(diagnostics.latestReconcile));
      }
      return lines.join("\\n");
    }

    function formatArtifactEventDetails(items) {
      if (!Array.isArray(items)) return String(items || "");
      return items.map((item) => {
        if (!item || typeof item !== "object") return String(item);
        return [
          item.kind || "artifact",
          item.reason || "",
          item.path || "",
          item.candidatePath ? "candidate=" + item.candidatePath : ""
        ].filter(Boolean).join(" ");
      }).join("; ");
    }

    async function loadExecutionSnapshot(workflowId, projectRoot, activateExecutionTab) {
      if (!workflowId) return;
      try {
        const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent("EXEC-" + workflowId) + "?projectRoot=" + encodeURIComponent(projectRoot || getProjectRoot()));
        state.execution = await readResponse(response);
        if (activateExecutionTab) {
          state.activeTab = "execution";
          activateTab("execution");
        }
        renderActiveTab();
        updateSummary();
        if (["running", "waiting_manual_gate", "paused_for_replan"].includes(state.execution.status)) {
          startPollingExecutionJob(state.execution.jobId);
        }
      } catch (error) {
        if (!String(error.message || error).includes("execution job not found")) {
          setStatus("warn", "已读取工作流产物，但未挂载连续执行状态：" + (error.message || String(error)));
        }
      }
    }

    async function pollExecutionJob(jobId) {
      const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "?projectRoot=" + encodeURIComponent(getProjectRoot()));
      state.execution = await readResponse(response);
      renderActiveTab();
      updateSummary();
      if (!["running", "waiting_manual_gate", "paused_for_replan"].includes(state.execution.status) && state.executionPollTimer) {
        clearInterval(state.executionPollTimer);
        state.executionPollTimer = null;
      }
    }

    async function startContinuousExecution(busyMessage) {
      const workflowId = state.result?.workflow?.workflowId || state.workflowId;
      if (!workflowId) return;
      setBusy(true, busyMessage);
      try {
        const response = await fetch("/api/ao/execution-jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowId,
            projectRoot: getProjectRoot(),
            dryRun: false
          })
        });
        state.execution = await readResponse(response);
        state.activeTab = "execution";
        activateTab("execution");
        renderActiveTab();
        updateSummary();
        setStatus("ok", getExecutionSuccessMessage(state.execution));
        startPollingExecutionJob(state.execution.jobId);
      } catch (error) {
        const message = error.message || String(error);
        if (message.includes("Workflow execution is failed")) {
          await loadExecutionSnapshot(workflowId, getProjectRoot(), true);
          setStatus("warn", "连续执行已中断，请在 AO 执行页选择重试任务、人工标记完成或提交重规划请求。");
        } else {
          setStatus("bad", message);
        }
      } finally {
        setBusy(false);
      }
    }

    async function submitExecutionRecovery(action, busyMessage, rationale) {
      const taskId = getRecoverableExecutionTaskId();
      const jobId = state.execution?.jobId;
      if (!taskId || !jobId) return;
      setBusy(true, busyMessage);
      try {
        let response;
        if (action === "retry") {
          response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/tasks/" + encodeURIComponent(taskId) + "/retry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectRoot: getProjectRoot() })
          });
          state.execution = await readResponse(response);
          setStatus("ok", "已提交重试，调度器会重新派发当前任务。");
        } else if (action === "mark-completed") {
          response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/tasks/" + encodeURIComponent(taskId) + "/mark-completed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectRoot: getProjectRoot(),
              rationale: rationale || "Web UI 人工标记完成"
            })
          });
          state.execution = await readResponse(response);
          setStatus("ok", "已人工确认当前任务完成，调度器会继续后续任务。");
        } else {
          response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/revision-requests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectRoot: getProjectRoot(),
              workflowId: state.execution.workflowId,
              triggerTaskId: taskId,
              reasonCategory: getRevisionReasonCategory(),
              rationale: rationale || getDefaultRevisionRationale()
            })
          });
          const result = await readResponse(response);
          state.execution = result.job || result;
          setStatus("ok", "已提交重规划请求。");
        }
        state.activeTab = "execution";
        activateTab("execution");
        renderActiveTab();
        updateSummary();
        if (["running", "waiting_manual_gate", "paused_for_replan"].includes(state.execution.status)) {
          startPollingExecutionJob(jobId);
        }
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function reconcileArtifacts(busyMessage) {
      const jobId = state.execution?.jobId;
      if (!jobId) return;
      setBusy(true, busyMessage);
      try {
        const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/reconcile-artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: getProjectRoot() })
        });
        const result = await readResponse(response);
        state.execution = result.job || result;
        state.activeTab = "execution";
        activateTab("execution");
        renderActiveTab();
        updateSummary();
        setStatus(result.completed ? "ok" : "warn", result.completed ? "产物校验通过，调度器会继续后续任务。" : "已完成重新检查，结果：" + (result.failureKind || "未完成") + "，请查看 AO 执行页的产物归集日志。");
        if (["running", "waiting_manual_gate", "paused_for_replan"].includes(state.execution.status)) {
          startPollingExecutionJob(jobId);
        }
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function submitManualGateDecision(decision, rationale) {
      const taskId = getManualGateBlockedTaskIds()[0];
      const jobId = state.execution?.jobId;
      if (!taskId || !jobId) return;
      setBusy(true, "正在提交门禁决策...");
      try {
        const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/manual-gates/" + encodeURIComponent(taskId) + "/decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectRoot: getProjectRoot(),
            decision,
            rationale
          })
        });
        state.execution = await readResponse(response);
        renderActiveTab();
        updateSummary();
        setStatus("ok", "门禁决策已提交。");
        if (decision === "approved") startPollingExecutionJob(jobId);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function approveManualGate(rationale) {
      const taskId = getManualGateBlockedTaskIds()[0];
      const jobId = state.execution?.jobId;
      if (!taskId || !jobId) return;
      setBusy(true, "正在门禁放行...");
      try {
        const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/manual-gates/" + encodeURIComponent(taskId) + "/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectRoot: getProjectRoot(),
            rationale
          })
        });
        state.execution = await readResponse(response);
        renderActiveTab();
        updateSummary();
        setStatus("ok", "门禁已放行，调度器会继续后续任务。");
        startPollingExecutionJob(jobId);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function dispatchManualGateReview(rationale) {
      const taskId = getManualGateBlockedTaskIds()[0];
      const jobId = state.execution?.jobId;
      if (!taskId || !jobId) return;
      setBusy(true, "正在派发门禁复核...");
      try {
        const response = await fetch("/api/ao/execution-jobs/" + encodeURIComponent(jobId) + "/manual-gates/" + encodeURIComponent(taskId) + "/dispatch-review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectRoot: getProjectRoot(),
            rationale
          })
        });
        state.execution = await readResponse(response);
        renderActiveTab();
        updateSummary();
        setStatus("ok", "门禁复核已派发给 AO。");
        startPollingExecutionJob(jobId);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    function startPollingExecutionJob(jobId) {
      if (!jobId) return;
      if (state.executionPollTimer) clearInterval(state.executionPollTimer);
      pollExecutionJob(jobId).catch((error) => setStatus("bad", error.message || String(error)));
      state.executionPollTimer = setInterval(async () => {
        try {
          await pollExecutionJob(jobId);
        } catch (error) {
          clearInterval(state.executionPollTimer);
          state.executionPollTimer = null;
          setStatus("bad", error.message || String(error));
        }
      }, 2000);
    }

    function getManualGateBlockedTaskIds() {
      if (state.execution?.status === "waiting_manual_gate" && state.execution.currentTaskId) {
        return [state.execution.currentTaskId];
      }
      return (state.execution?.blockedTasks || [])
        .filter((task) => task.kind === "manual_gate")
        .map((task) => task.taskId)
        .filter(Boolean);
    }

    function getRecoverableExecutionTaskId() {
      return state.execution?.activeTask?.taskId || state.execution?.currentTaskId || "";
    }

    function canRecoverExecutionTask() {
      const status = state.execution?.status;
      return Boolean(getRecoverableExecutionTaskId() && (status === "failed" || status === "paused_for_replan"));
    }

    function canRetryExecutionTask() {
      const taskId = getRecoverableExecutionTaskId();
      const taskStatus = state.execution?.activeTask?.status;
      const failedDuringDispatch =
        state.execution?.status === "failed" &&
        state.execution?.failure?.taskId === taskId &&
        state.execution?.failure?.kind === "ao_spawn_failed";
      return canRecoverExecutionTask() && (taskStatus === "blocked_for_human" || taskStatus === "failed" || failedDuringDispatch);
    }

    function canReconcileArtifacts() {
      const kind = state.execution?.failure?.kind || "";
      return Boolean(getRecoverableExecutionTaskId()) &&
        (state.execution?.status === "failed" || state.execution?.status === "paused_for_replan") &&
        (kind.includes("artifact_output") || kind === "");
    }

    function getReconcileArtifactsButtonTitle() {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return "任务产物缺失或冲突时，可重新检查 AO worktree 产物。";
      if (canReconcileArtifacts()) return "重新检查任务 " + taskId + " 的 canonical 产物，并尝试从 AO worktree 归集。";
      return "仅产物缺失、产物冲突或归集失败的中断任务需要重新检查产物。";
    }

    function getExecutionRecoveryButtonTitle(action) {
      const taskId = getRecoverableExecutionTaskId();
      if (!taskId) return "连续执行中断后可处理当前任务。";
      if (action === "retry") {
        return canRetryExecutionTask()
          ? "重新派发当前任务 " + taskId + "。"
          : "只有 failed、blocked_for_human 或派发失败的任务可以重试。";
      }
      if (action === "mark-completed") return "人工把当前任务 " + taskId + " 标记为已完成，并继续后续任务。";
      return "基于当前任务 " + taskId + " 提交重规划请求。";
    }

    function getRevisionReasonCategory() {
      const kind = state.execution?.failure?.kind || "";
      if (kind.includes("session")) return "ao_session_missing";
      if (kind.includes("manual_gate")) return "manual_gate";
      if (kind.includes("dependency")) return "dependency_deadlock";
      if (kind.includes("plan")) return "plan_issue";
      return kind || "execution_interrupted";
    }

    function getDefaultRevisionRationale() {
      const failure = state.execution?.failure;
      if (failure?.message) return failure.message;
      const taskId = getRecoverableExecutionTaskId();
      return taskId ? "任务 " + taskId + " 执行中断，需要修复任务计划后继续。" : "连续执行中断，需要修复任务计划后继续。";
    }

    function getReleaseManualGateButtonTitle() {
      const count = getManualGateBlockedTaskIds().length;
      if (count > 0) return "人工批准当前等待的 " + count + " 个 manual_gate，并由控制平面生成门禁产物。";
      return "manual_gate 等待时，人工批准门禁并继续执行。";
    }

    function canDispatchManualGateReview() {
      const context = state.execution?.manualGateContext;
      return getManualGateBlockedTaskIds().length > 0 &&
        (!context || ((context.inputArtifacts || []).length > 0 && (context.missingArtifacts || []).length === 0));
    }

    function getDispatchManualGateReviewButtonTitle() {
      const context = state.execution?.manualGateContext;
      if (!getManualGateBlockedTaskIds().length) return "manual_gate 等待时，可派发 AO reviewer 复核。";
      if (context && (context.inputArtifacts || []).length === 0) return "当前门禁没有结构化输入产物，不能派发 AO reviewer；请补齐产物契约或提交重规划请求。";
      if ((context?.missingArtifacts || []).length > 0) return "存在缺失输入产物，不能派发 AO reviewer；请补齐产物或提交重规划请求。";
      return "派发 AO reviewer 复核当前门禁上下文产物。";
    }

    function getManualGateDecisionButtonTitle(decision) {
      const count = getManualGateBlockedTaskIds().length;
      if (count === 0) return "manual_gate 等待时，可要求重规划或标记阻断。";
      if (decision === "requires_replan") return "将当前等待的 " + count + " 个 manual_gate 标记为需要重规划。";
      return "将当前等待的 " + count + " 个 manual_gate 标记为阻断执行。";
    }

    function formatManualGateContext(context) {
      const lines = [
        "门禁上下文：",
        "当前门禁：" + context.taskId + " / " + (context.title || "未命名门禁"),
        "复核目标：" + (context.description || "未提供描述。"),
        "依赖任务：" + ((context.dependencies || []).join("、") || "无"),
        "验收标准："
      ];
      if ((context.acceptanceCriteria || []).length === 0) {
        lines.push("- 未声明验收标准。");
      } else {
        (context.acceptanceCriteria || []).forEach((criterion, index) => {
          lines.push(String(index + 1) + ". " + criterion);
        });
      }
      lines.push(
        "AO 复核提示：",
        context.aoPrompt || "未提供 AO prompt。",
        "可审查输入产物："
      );
      const missingPaths = new Set((context.missingArtifacts || []).map((artifact) => artifact.path));
      if ((context.inputArtifacts || []).length === 0) {
        lines.push("- 无结构化输入产物。");
      } else {
        (context.inputArtifacts || []).forEach((artifact) => {
          lines.push("- " + (missingPaths.has(artifact.path) ? "缺失 " : "存在 ") + artifact.kind + "：" + artifact.path);
        });
      }
      lines.push("门禁预期输出：");
      if ((context.expectedOutputs || []).length === 0) {
        lines.push("- 未声明预期输出。");
      } else {
        (context.expectedOutputs || []).forEach((artifact) => {
          lines.push("- " + artifact.kind + "：" + artifact.path);
        });
      }
      if ((context.missingArtifacts || []).length > 0) {
        lines.push("缺失产物告警：");
        (context.missingArtifacts || []).forEach((artifact) => {
          lines.push("- " + (artifact.taskId ? artifact.taskId + " / " : "") + artifact.kind + "：" + artifact.path);
        });
        lines.push("可直接点击“提交重规划请求”，或补齐上述产物后再派发门禁复核。");
      }
      if ((context.generatedArtifacts || []).length > 0) {
        lines.push("已生成门禁产物：");
        (context.generatedArtifacts || []).forEach((artifact) => lines.push("- " + artifact));
      }
      return lines.join("\\n");
    }

    function getExecutionSuccessMessage(execution) {
      if (execution?.jobId) {
        return "连续执行已启动，当前状态：" + execution.status + "。";
      }
      const sessionCount = execution?.sessions?.length || 0;
      const blockedCount = execution?.blockedTasks?.length || 0;
      return "AO 已派发 " + sessionCount + " 个任务" + (blockedCount > 0 ? "，" + blockedCount + " 个任务仍在等待。" : "。");
    }

    function getDispatchableTaskCount(releasedManualGateTaskIds) {
      const tasks = state.result?.plan?.tasks || [];
      const released = new Set((releasedManualGateTaskIds || []).map((release) => {
        if (typeof release === "string") return release;
        return release.decision === "approved" ? release.taskId : "";
      }));
      const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.taskId));
      const alreadyWorking = new Set(
        tasks
          .filter((task) => task.status === "working" || Boolean(task.aoSessionId))
          .map((task) => task.taskId)
      );
      return tasks.filter((task) => {
        if (task.status !== "pending" || alreadyWorking.has(task.taskId)) return false;
        if (task.dependencyCondition === "manual_gate" && !released.has(task.taskId)) return false;
        const dependencies = task.dependencies || [];
        if (dependencies.length === 0) return true;
        if (task.dependencyCondition === "any_completed") {
          return dependencies.some((dependency) => completed.has(dependency));
        }
        return dependencies.every((dependency) => completed.has(dependency));
      }).length;
    }

    function getTaskPlanApprovalReport() {
      return state.result?.taskPlanApprovalReport || state.job?.result?.taskPlanApprovalReport || null;
    }

    function getActivePlan() {
      const finalPlan = state.result?.plan || state.job?.plan || state.job?.result?.plan || null;
      if (finalPlan) return { plan: finalPlan, isDraft: false };
      const draftPlan = state.result?.draftPlan || state.job?.result?.draftPlan || null;
      return draftPlan ? { plan: draftPlan, isDraft: true } : { plan: null, isDraft: false };
    }

    function getCurrentPlan() {
      return getActivePlan().plan;
    }

    function getTaskPlanNormalizationReports() {
      return state.result?.taskPlanNormalizationReports || state.job?.result?.taskPlanNormalizationReports || [];
    }

    function getTaskPlanNormalizationReportErrors() {
      return state.result?.taskPlanNormalizationReportErrors || state.job?.result?.taskPlanNormalizationReportErrors || [];
    }

    function getTaskPlanReviews() {
      return state.result?.taskPlanReviews || state.job?.taskPlanReviews || state.job?.result?.taskPlanReviews || [];
    }

    function formatTaskCount() {
      const activePlan = getActivePlan();
      if (!activePlan.plan?.tasks) return "-";
      return String(activePlan.plan.tasks.length) + (activePlan.isDraft ? "（草稿）" : "");
    }

    function formatPlanTabContent() {
      const activePlan = getActivePlan();
      const plan = activePlan.plan;
      if (!plan) return "任务计划：暂无。";
      return [
        activePlan.isDraft ? "任务计划草稿：尚未通过最终审查或仲裁。" : "任务计划：已通过。",
        "",
        JSON.stringify(plan, null, 2)
      ].join("\\n");
    }

    function formatPlanReviewTabContent() {
      const report = getTaskPlanApprovalReport();
      const reviews = getTaskPlanReviews();
      const latestReview = reviews.length ? reviews[reviews.length - 1] : null;
      const summary = report ? formatTaskPlanApprovalSummary(report) : "审批报告：暂无。";
      return [
        summary,
        "",
        "最新任务计划审查：",
        JSON.stringify(latestReview, null, 2),
        "",
        "审批报告 JSON：",
        JSON.stringify(report, null, 2)
      ].join("\\n");
    }

    function formatTaskPlanApprovalSummary(report) {
      const dispatch = report.dispatchSummary || {};
      const missingCoverage = (report.designCoverageTrace || [])
        .filter((trace) => trace.status === "missing")
        .map((trace) => trace.requirementId);
      const unresolvedFindings = (report.findingSummary || [])
        .filter((finding) => finding.status === "unresolved")
        .map((finding) => finding.id);
      const normalizationSummary = formatTaskPlanNormalizationSummary(report);
      return [
        normalizationSummary,
        "",
        "审批状态：" + (report.approved ? "通过" : "未通过"),
        "可实施状态：" + formatPlanReadiness(report.planReadiness),
        "可派发任务：" + Number(dispatch.dispatchableTaskCount || 0),
        "等待任务：" + Number(dispatch.waitingTaskCount || 0),
        "人工门禁：" + Number(dispatch.manualGateTaskCount || 0),
        "阻断 finding：" + Number(dispatch.blockingFindingCount || 0),
        "覆盖缺口：" + (missingCoverage.length ? missingCoverage.join("、") : "无"),
        "待处理 finding：" + (unresolvedFindings.length ? unresolvedFindings.join("、") : "无")
      ].join("\\n");
    }

    function formatTaskPlanNormalizationSummary(approvalReport) {
      const reports = getTaskPlanNormalizationReports();
      const reportErrors = getTaskPlanNormalizationReportErrors();
      const latestReport = reports.length ? reports[reports.length - 1] : null;
      const reportSummary = latestReport || approvalReport?.normalizationReport || state.result?.workflow?.lastNormalization || state.job?.result?.workflow?.lastNormalization;
      if (!reportSummary && !latestReport && !reportErrors.length) {
        return "归一化状态：暂无。";
      }
      const round = latestReport?.round ?? reportSummary?.round ?? 0;
      const outcome = latestReport?.outcome ?? reportSummary?.outcome ?? "passed";
      const changeCount = latestReport?.changes?.length ?? reportSummary?.changeCount ?? 0;
      const droppedEntryCount = latestReport?.droppedEntries?.length ?? reportSummary?.droppedEntryCount ?? 0;
      const reportPath = latestReport ? "task-plan-normalization-report-" + round + ".json" : reportSummary?.reportPath || (round ? "task-plan-normalization-report-" + round + ".json" : "");
      const rawErrors = latestReport?.rawSchemaErrors?.length || 0;
      const strictErrors = latestReport?.strictSchemaErrors?.length || 0;
      const sourceHistory = latestReport?.sourceHistory || [];
      const lines = [
        "归一化状态：" + formatNormalizationOutcome(outcome),
        "归一化轮次：" + round,
        "归一化变更：" + changeCount,
        "丢弃条目：" + droppedEntryCount,
        "格式错误：" + rawErrors,
        "严格校验错误：" + strictErrors,
        "归一化报告：" + (reportPath || "未记录")
      ];
      if (reportErrors.length) {
        lines.push("损坏报告：" + formatNormalizationReportErrors(reportErrors));
        lines.push("损坏报告明细：");
        formatNormalizationReportErrorGroups(reportErrors).forEach((group) => {
          lines.push("- round " + group.round + "：" + group.errors.length + " 个");
          group.errors.forEach((error) => {
            lines.push("  - " + formatNormalizationReportErrorDetail(error));
          });
        });
      }
      if (sourceHistory.length) {
        lines.push("来源演化：");
        sourceHistory.forEach((entry) => {
          lines.push("- " + entry.source + " / round " + entry.round + " / " + entry.reason);
        });
      }
      return lines.join("\\n");
    }

    function formatNormalizationReportErrors(errors) {
      const critical = errors.filter((error) => error.severity === "critical").length;
      const warning = errors.length - critical;
      return errors.length + "（critical " + critical + " / warning " + warning + "）";
    }

    function formatNormalizationReportErrorGroups(errors) {
      const groups = new Map();
      errors.forEach((error) => {
        const round = Number(error.round || 0);
        if (!groups.has(round)) groups.set(round, []);
        groups.get(round).push(error);
      });
      return Array.from(groups.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([round, groupedErrors]) => ({
          round,
          errors: groupedErrors.slice().sort(compareNormalizationReportErrors)
        }));
    }

    function formatNormalizationReportErrorDetail(error) {
      return error.severity + " / " + error.message + (error.details ? " / details " + error.details : "") + formatNormalizationReportErrorDetailFields(error);
    }

    function formatNormalizationReportErrorDetailFields(error) {
      const fields = (error.issues || [])
        .flatMap((issue) => Object.entries(issue.detailFields || {}).map(([key, value]) => issue.path + "." + key + "=" + value));
      return fields.length ? " / fields " + fields.join(", ") : "";
    }

    function getNormalizationErrorSeverityRank(error) {
      return error.severity === "critical" ? 0 : 1;
    }

    function compareNormalizationReportErrors(left, right) {
      const severity = getNormalizationErrorSeverityRank(left) - getNormalizationErrorSeverityRank(right);
      if (severity !== 0) return severity;
      const leftIssue = (left.issues || [])[0] || {};
      const rightIssue = (right.issues || [])[0] || {};
      const code = String(leftIssue.code || "").localeCompare(String(rightIssue.code || ""));
      if (code !== 0) return code;
      return String(leftIssue.path || left.path || "").localeCompare(String(rightIssue.path || right.path || ""));
    }

    function formatNormalizationOutcome(outcome) {
      if (outcome === "passed") return "已通过";
      if (outcome === "raw_failed") return "原始结构失败";
      if (outcome === "strict_failed") return "严格校验失败";
      return "未知（" + String(outcome || "未记录") + "）";
    }

    function formatPlanReadiness(readiness) {
      if (readiness === "directly_implementable") return "可直接实施";
      if (readiness === "gated_implementable") return "门禁后可实施";
      if (readiness === "calibration_only") return "仅校准，需重规划";
      return "未知";
    }

    function outputHasSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
      return Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some((range) => {
        return output.contains(range.commonAncestorContainer) ||
          range.intersectsNode(output) ||
          executionDetails.contains(range.commonAncestorContainer) ||
          range.intersectsNode(executionDetails);
      });
    }
  </script>
</body>
</html>`;
}
