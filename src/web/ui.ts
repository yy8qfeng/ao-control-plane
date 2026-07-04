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
          <button id="executeButton" class="secondary" type="button" disabled>派发执行</button>
          <button id="releaseManualGateButton" class="secondary" type="button" disabled title="先点击派发执行，以识别需要人工放行的 manual_gate 任务。">放行门禁</button>
          <button id="replanManualGateButton" class="secondary" type="button" disabled title="先点击派发执行，以识别需要人工决策的 manual_gate 任务。">要求重规划</button>
          <button id="blockManualGateButton" class="secondary" type="button" disabled title="先点击派发执行，以识别需要人工决策的 manual_gate 任务。">标记阻断</button>
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
    const releaseManualGateButton = document.querySelector("#releaseManualGateButton");
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

    draftHistory.addEventListener("change", () => {
      const selected = state.requirementDrafts[Number(draftHistory.value)];
      if (!selected) return;
      restoreDraft(selected);
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
        restoreDraft(config.requirementDraft || config.requirementDrafts?.[0]);
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
      const dispatchableCount = getDispatchableTaskCount([]);
      if (!confirm("即将真实派发 " + dispatchableCount + " 个任务到 AO，是否继续？")) return;
      await executeAoPlan([], "正在向 AO 派发任务...");
    });

    releaseManualGateButton.addEventListener("click", async () => {
      const releases = createManualGateReleases("approved", "Web UI 人工放行");
      if (!confirm("即将真实放行并派发 " + releases.length + " 个 manual_gate 任务到 AO，是否继续？")) return;
      await executeAoPlan(releases, "正在放行 manual_gate 任务...");
    });

    replanManualGateButton.addEventListener("click", async () => {
      const releases = createManualGateReleases("requires_replan", "Web UI 要求重规划");
      if (!confirm("即将把 " + releases.length + " 个 manual_gate 标记为需要重规划，旧后续任务不会被放行，是否继续？")) return;
      await executeAoPlan(releases, "正在标记 manual_gate 需要重规划...");
    });

    blockManualGateButton.addEventListener("click", async () => {
      const releases = createManualGateReleases("blocked", "Web UI 标记阻断");
      if (!confirm("即将把 " + releases.length + " 个 manual_gate 标记为阻断，旧后续任务不会被放行，是否继续？")) return;
      await executeAoPlan(releases, "正在标记 manual_gate 阻断...");
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
        restoreDraft(config.requirementDraft);
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

    function restoreDraft(draft) {
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
      executeButton.disabled = busy || state.result?.workflow?.status !== "executing" || !state.result?.plan;
      releaseManualGateButton.disabled = busy || getManualGateBlockedTaskIds().length === 0;
      releaseManualGateButton.title = getReleaseManualGateButtonTitle();
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
      document.querySelector("#workflowId").textContent = result?.workflow?.workflowId || job?.result?.workflow?.workflowId || state.workflowId || "未生成";
      document.querySelector("#workflowStatus").textContent = job?.currentStep || result?.workflow?.status || job?.status || "-";
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
      executeButton.disabled = running || result?.workflow?.status !== "executing" || !result?.plan;
      releaseManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      releaseManualGateButton.title = getReleaseManualGateButtonTitle();
      replanManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      replanManualGateButton.title = getManualGateDecisionButtonTitle("requires_replan");
      blockManualGateButton.disabled = running || getManualGateBlockedTaskIds().length === 0;
      blockManualGateButton.title = getManualGateDecisionButtonTitle("blocked");
    }

    function canReviewTaskPlan(result) {
      const workflowStatus = result?.workflow?.status;
      return workflowStatus === "ready_for_planning" || Boolean(result?.plan) || Boolean(state.workflowId);
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
        output.textContent = "填写需求后点击生成。";
        return;
      }

      if (state.activeTab === "logs") {
        const timer = state.job ? ["当前步骤：" + state.job.currentStep, "已等待：" + state.job.elapsedSeconds + " 秒", ""].join("\\n") : "";
        output.textContent = timer + ((state.job?.logs || []).join("\\n") || "等待流程开始。");
      } else if (state.activeTab === "design") {
        output.textContent = state.job?.design?.content || state.result?.design || "";
      } else if (state.activeTab === "reviews") {
        const reviews = state.job?.reviews || state.result?.reviews || [];
        if (state.job?.reviews?.length) {
          output.textContent = JSON.stringify(reviews[reviews.length - 1] || null, null, 2);
        } else {
          output.textContent = JSON.stringify(reviews, null, 2);
        }
      } else if (state.activeTab === "plan") {
        output.textContent = formatPlanTabContent();
      } else if (state.activeTab === "planReview") {
        output.textContent = formatPlanReviewTabContent();
      } else {
        output.textContent = JSON.stringify(state.execution || { message: "尚未执行 AO 派发。" }, null, 2);
      }
    }

    async function executeAoPlan(releasedManualGateTaskIds, busyMessage) {
      if (!state.result?.workflow?.workflowId) return;
      setBusy(true, busyMessage);
      try {
        const response = await fetch("/api/ao/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowId: state.result.workflow.workflowId,
            projectRoot: getProjectRoot(),
            dryRun: false,
            releasedManualGateTaskIds
          })
        });
        state.execution = await readResponse(response);
        state.activeTab = "execution";
        activateTab("execution");
        renderActiveTab();
        updateSummary();
        setStatus("ok", getExecutionSuccessMessage(state.execution));
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    function getManualGateBlockedTaskIds() {
      return (state.execution?.blockedTasks || [])
        .filter((task) => task.kind === "manual_gate")
        .map((task) => task.taskId)
        .filter(Boolean);
    }

    function getReleaseManualGateButtonTitle() {
      const count = getManualGateBlockedTaskIds().length;
      if (count > 0) return "放行当前识别到的 " + count + " 个 manual_gate 任务。";
      return "先点击派发执行，以识别需要人工放行的 manual_gate 任务。";
    }

    function getManualGateDecisionButtonTitle(decision) {
      const count = getManualGateBlockedTaskIds().length;
      if (count === 0) return "先点击派发执行，以识别需要人工决策的 manual_gate 任务。";
      if (decision === "requires_replan") return "将当前识别到的 " + count + " 个 manual_gate 标记为需要重规划。";
      return "将当前识别到的 " + count + " 个 manual_gate 标记为阻断。";
    }

    function createManualGateReleases(decision, rationale) {
      return getManualGateBlockedTaskIds().map((taskId) => ({
        taskId,
        decision,
        rationale,
        releasedAt: new Date().toISOString()
      }));
    }

    function getExecutionSuccessMessage(execution) {
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
        return output.contains(range.commonAncestorContainer) || range.intersectsNode(output);
      });
    }
  </script>
</body>
</html>`;
}
