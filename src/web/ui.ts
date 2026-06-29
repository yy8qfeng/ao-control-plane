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
      grid-template-columns: repeat(4, minmax(0, 1fr));
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
    <div id="headerStatus" class="status">本地治理控制台</div>
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
          <button id="reviewButton" type="submit">开始设计审查循环</button>
          <button id="rerunButton" class="secondary" type="submit">补充需求并重新审查</button>
          <button id="planButton" class="secondary" type="button" disabled>生成任务计划</button>
          <button id="dryRunButton" class="secondary" type="button" disabled>预演执行</button>
        </div>
        <div id="formStatus" class="status"></div>
      </form>
    </section>

    <section class="workspace">
      <div>
        <div class="summary">
          <div class="metric"><span>Workflow</span><strong id="workflowId">未生成</strong></div>
          <div class="metric"><span>状态</span><strong id="workflowStatus">-</strong></div>
          <div class="metric"><span>审查轮次</span><strong id="reviewCount">0</strong></div>
          <div class="metric"><span>任务数</span><strong id="taskCount">0</strong></div>
        </div>
        <div class="tabs">
          <button class="tab active" type="button" data-tab="design">设计稿</button>
          <button class="tab" type="button" data-tab="reviews">审查</button>
          <button class="tab" type="button" data-tab="plan">任务计划</button>
          <button class="tab" type="button" data-tab="execution">执行预演</button>
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
    const headerStatus = document.querySelector("#headerStatus");
    const reviewButton = document.querySelector("#reviewButton");
    const rerunButton = document.querySelector("#rerunButton");
    const planButton = document.querySelector("#planButton");
    const dryRunButton = document.querySelector("#dryRunButton");
    const projectButton = document.querySelector("#projectButton");
    const projectDialog = document.querySelector("#projectDialog");
    const closeProjectDialog = document.querySelector("#closeProjectDialog");
    const useCurrentPath = document.querySelector("#useCurrentPath");
    const parentPathButton = document.querySelector("#parentPathButton");
    const projectList = document.querySelector("#projectList");
    const directoryList = document.querySelector("#directoryList");
    const currentPath = document.querySelector("#currentPath");
    const projectRootInput = document.querySelector('input[name="projectRoot"]');
    const state = { result: null, execution: null, activeTab: "design", browsingPath: "" };

    loadProjects();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await runStep(
        "/api/governance/design-review",
        "正在由 Codex 生成设计，并交由 ClaudeCode 审查...",
        "设计审查循环已完成。若补充需求后重新审查，审查轮次会从 1 开始。",
        "design"
      );
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

    planButton.addEventListener("click", async () => {
      if (!state.result?.workflow?.workflowId) return;
      setBusy(true, "正在生成任务计划...");
      try {
        const response = await fetch("/api/governance/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowId: state.result.workflow.workflowId,
            projectRoot: getProjectRoot()
          })
        });
        state.result = await readResponse(response);
        state.activeTab = "plan";
        activateTab("plan");
        updateSummary();
        renderActiveTab();
        setStatus("ok", "任务计划已生成。");
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    });

    dryRunButton.addEventListener("click", async () => {
      if (!state.result?.workflow?.workflowId) return;
      setBusy(true, "正在预演 AO 下发...");
      try {
        const response = await fetch("/api/ao/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowId: state.result.workflow.workflowId,
            projectRoot: getProjectRoot(),
            dryRun: true
          })
        });
        state.execution = await readResponse(response);
        state.activeTab = "execution";
        activateTab("execution");
        renderActiveTab();
        setStatus("ok", "预演完成。");
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.activeTab = tab.dataset.tab;
        activateTab(state.activeTab);
        renderActiveTab();
      });
    });

    async function runStep(path, busyMessage, successMessage, nextTab) {
      setBusy(true, busyMessage);
      state.execution = null;
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildGovernancePayload())
        });
        state.result = await readResponse(response);
        state.activeTab = nextTab;
        activateTab(nextTab);
        updateSummary();
        renderActiveTab();
        setStatus("ok", successMessage + " " + state.result.artifactDir);
      } catch (error) {
        setStatus("bad", error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function loadProjects() {
      try {
        const response = await fetch("/api/projects");
        const config = await readResponse(response);
        renderProjects(config);
        if (config.selectedProjectRoot) {
          projectRootInput.value = config.selectedProjectRoot;
        }
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

    function buildGovernancePayload() {
      const formData = new FormData(form);
      return {
        projectRoot: getProjectRoot(),
        workflowId: state.result?.workflow?.workflowId,
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

    async function readResponse(response) {
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "请求失败");
      }
      return json;
    }

    function setBusy(busy, message = "") {
      reviewButton.disabled = busy;
      rerunButton.disabled = busy;
      planButton.disabled = busy || state.result?.workflow?.status !== "ready_for_planning";
      dryRunButton.disabled = busy || !state.result?.plan;
      if (message) setStatus("warn", message);
    }

    function setStatus(kind, message) {
      formStatus.className = "status " + kind;
      headerStatus.className = "status " + kind;
      formStatus.textContent = message;
      headerStatus.textContent = message || "本地治理控制台";
    }

    function activateTab(tabName) {
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === tabName);
      });
    }

    function updateSummary() {
      const result = state.result;
      document.querySelector("#workflowId").textContent = result?.workflow?.workflowId || "未生成";
      document.querySelector("#workflowStatus").textContent = result?.workflow?.status || "-";
      document.querySelector("#reviewCount").textContent = String(result?.reviews?.length || 0);
      document.querySelector("#taskCount").textContent = String(result?.plan?.tasks?.length || 0);
      planButton.disabled = result?.workflow?.status !== "ready_for_planning";
      dryRunButton.disabled = !result?.plan;
    }

    function renderActiveTab() {
      if (!state.result) {
        output.textContent = "填写需求后点击生成。";
        return;
      }

      if (state.activeTab === "design") {
        output.textContent = state.result.design || "";
      } else if (state.activeTab === "reviews") {
        output.textContent = JSON.stringify(state.result.reviews || [], null, 2);
      } else if (state.activeTab === "plan") {
        output.textContent = JSON.stringify(state.result.plan || null, null, 2);
      } else {
        output.textContent = JSON.stringify(state.execution || { message: "尚未执行预演。" }, null, 2);
      }
    }
  </script>
</body>
</html>`;
}
