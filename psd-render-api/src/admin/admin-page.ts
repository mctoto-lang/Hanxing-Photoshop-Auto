/**
 * Admin UI 单页 HTML（规范：后端内嵌简单页面，内网访问）
 * 通过 /admin/api/* 拉取数据，前端渲染。
 */
export const adminPageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2Ij48cGF0aCBkPSJNNjQgMzg4LjI1NmMwLTExMy41MDQgMC0xNzAuMjQgMjIuMDgtMjEzLjZBMjAyLjY1NiAyMDIuNjU2IDAgMCAxIDE3NC42NTYgODYuMDhDMjE4LjAxNiA2NCAyNzQuNzUyIDY0IDM4OC4yNTYgNjRoMjQ3LjQ4OGMxMTMuNTA0IDAgMTcwLjI0IDAgMjEzLjYgMjIuMDhhMjAyLjY1NiAyMDIuNjU2IDAgMCAxIDg4LjU3NiA4OC41NzZjMjIuMDggNDMuMzYgMjIuMDggMTAwLjA5NiAyMi4wOCAyMTMuNnYyNDcuNDg4YzAgMTEzLjUwNCAwIDE3MC4yNC0yMi4wOCAyMTMuNmEyMDIuNjU2IDIwMi42NTYgMCAwIDEtODguNTc2IDg4LjU3NmMtNDMuMzYgMjIuMDgtMTAwLjA5NiAyMi4wOC0yMTMuNiAyMi4wOGgtMjQ3LjQ4OGMtMTEzLjUwNCAwLTE3MC4yNCAwLTIxMy42LTIyLjA4YTIwMi42NTYgMjAyLjY1NiAwIDAgMS04OC41NzYtODguNTc2QzY0IDgwNS45ODQgNjQgNzQ5LjI0OCA2NCA2MzUuNzQ0di0yNDcuNDg4eiIgZmlsbD0iIzAwMUUzNiIvPjxwYXRoIGQ9Ik0yNTYgNzIwLjUxMlYzMjYuNDk2YzAtMi42NTYgMS4xMi00LjE5MiAzLjc0NC00LjE5MiAzOC41NiAwIDc3LjEyLTIuMzA0IDExNS43MTItMi4zMDQgNjIuNjI0IDAgMTMwLjQzMiAyMS40NCAxNTQuMjA4IDg2LjkxMiA1LjYgMTYuMDk2IDguNTc2IDMyLjU0NCA4LjU3NiA0OS43OTIgMCAzMi45MjgtNy40NTYgNjAuMDk2LTIyLjQgODEuNTM2LTQxLjcyOCA1OS45MDQtMTE0LjAxNiA1OC45NzYtMTc4LjgxNiA1OC45NzZ2MTIyLjkxMmMwLjQ4IDMuNjQ4LTIuNTkyIDUuMzc2LTUuNiA1LjM3NkgyNjAuNDhjLTIuOTc2IDAtNC40OC0xLjUzNi00LjQ4LTQuOTkyeiBtODEuMzc2LTMyNC4zMnYxMjguNjRjMjUuNjk2IDEuOTIgNTIuNjA4IDIuMTEyIDc3LjI4LTYuMDggMjcuMjY0LTcuODcyIDQyLjIwOC0zMS40ODggNDIuMjA4LTU5Ljc0NCAwLjczNi0yNC4wOTYtMTIuMzg0LTQ3LjIzMi0zNC43Mi01NS45MDQtMjQuNDE2LTEwLjE0NC01OC40MzItMTAuNzUyLTg0Ljc2OC02LjkxMnpNNzcxLjEwNCA0OTkuNDI0YTEzOC4xMTIgMTM4LjExMiAwIDAgMC0zNS43NzYtMTIuOTI4Yy0xNi0zLjc3Ni03OS4wNC0xNi45Ni03OS4wNCAxNiAwLjU0NCAxOC40MzIgMjkuNzYgMjcuNDI0IDQyLjY4OCAzMi43MDQgNDUuMzEyIDE1LjU1MiA5Ni41NzYgNDMuMzYgOTUuNTUyIDk5LjIzMiAxLjM3NiA2OS42LTY2LjAxNiA5Ny40MDgtMTIzLjg0IDk3LjQwOC0zMC4wOCAwLjMyLTYxLjQwOC00LjM1Mi04OC45Ni0xNy4yOGE4LjE2IDguMTYgMCAwIDEtNC4xNi03LjM2di02Ni41OTJjLTAuMzItMi42NTYgMi41Ni00Ljk5MiA0LjgtMy4wNzIgMjYuOTc2IDE2LjMyIDU4Ljk0NCAyNC4yMjQgOTAuMTQ0IDI0LjY0IDEzLjc2IDAgNDEuMDg4LTEuMzEyIDQwLjg5Ni0yMS41NjggMC0xOS40MjQtMzIuNjcyLTI4LjM1Mi00NS42OTYtMzMuMjhhMjE4Ljg4IDIxOC44OCAwIDAgMS01My4xODQtMjcuNzQ0IDg2LjUyOCA4Ni41MjggMCAwIDEtMzYuOTkyLTcxLjUyYy0wLjEyOC02NS41MDQgNjEuOTUyLTk0LjkxMiAxMTcuODI0LTk0Ljk0NCAyNi4xMTItMC4yMjQgNTQuMTc2IDEuNzI4IDc4LjQ5NiAxMi4zNTIgMy41MiAxLjAyNCA0LjIyNCA0LjcwNCA0LjIyNCA4djYyLjI3MmMwLjIyNCAzLjg0LTQuMDk2IDUuMTg0LTYuOTc2IDMuNjh6IiBmaWxsPSIjMzFBOEZGIi8+PC9zdmc+" />
  <title>Photoshop渲染农场服务控制台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
           background: #0f1419; color: #e6e6e6; padding: 20px; }
    h1 { font-size: 20px; margin-bottom: 16px; color: #4fc3f7; }
    h2 { font-size: 15px; margin: 24px 0 10px; color: #b39ddb; border-left: 3px solid #b39ddb; padding-left: 8px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat { background: #1a1f2e; padding: 14px; border-radius: 6px; border: 1px solid #2a3142; }
    .stat .label { font-size: 12px; color: #8b95a7; }
    .stat .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
    .stat.queued .value { color: #ffd54f; }
    .stat.processing .value { color: #4fc3f7; }
    .stat.succeeded .value { color: #81c784; }
    .stat.failed .value { color: #e57373; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: #1a1f2e; border-radius: 6px; overflow: hidden; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #2a3142; }
    th { background: #232a3d; color: #8b95a7; font-weight: 600; }
    tr:hover { background: #232a3d; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge.QUEUED { background: #3d3520; color: #ffd54f; }
    .badge.LEASED, .badge.PROCESSING { background: #1e3a4f; color: #4fc3f7; }
    .badge.SUCCEEDED { background: #1e3f28; color: #81c784; }
    .badge.FAILED { background: #3f1e1e; color: #e57373; }
    .badge.CANCELLED, .badge.CANCELLING { background: #3d2a4f; color: #ce93d8; }
    .badge.DRAFT { background: #2a2a3d; color: #b39ddb; }
    .badge.PUBLISHED { background: #1e3f28; color: #81c784; }
    .badge.REPUBLISH_REQUIRED, .badge.ARCHIVED { background: #3d3520; color: #ffd54f; }
    .badge.online { background: #1e3f28; color: #81c784; }
    .badge.offline { background: #3a2a2a; color: #999; }
    .sev-WARN { background: #3d3520; color: #ffd54f; }
    .sev-ERROR { background: #3f1e1e; color: #e57373; }
    .sev-CRITICAL { background: #5e1e1e; color: #ff6b6b; font-weight: 700; }
    .sev-INFO { background: #1e3a4f; color: #4fc3f7; }
    .alert-row { background: #1a1f2e; }
    .alert-row.CRITICAL { border-left: 3px solid #ff6b6b; }
    .alert-row.ERROR { border-left: 3px solid #e57373; }
    .alert-row.WARN { border-left: 3px solid #ffd54f; }
    .alert-row.RESOLVED, .alert-row.ACKED { opacity: 0.55; }
    .btn-ack { padding: 2px 8px; border-radius: 4px; border: 1px solid #4fc3f7; background: transparent; color: #4fc3f7; cursor: pointer; font-size: 11px; }
    .btn-ack:hover { background: #1e3a4f; }
    .btn-act { padding: 2px 6px; border-radius: 3px; border: 1px solid #4fc3f7; background: transparent; color: #4fc3f7; cursor: pointer; font-size: 11px; margin-right: 4px; }
    .btn-act:hover { background: #1e3a4f; }
    .btn-act.danger { border-color: #e57373; color: #e57373; }
    .btn-act.danger:hover { background: #3f1e1e; }
    .btn-act.warn { border-color: #ffd54f; color: #ffd54f; }
    .btn-act.warn:hover { background: #3f3a1e; }
    .btn-act:disabled { opacity: 0.4; cursor: not-allowed; }
    .ops { white-space: nowrap; }
    .refresh { float: right; font-size: 12px; color: #8b95a7; cursor: pointer; }
    .refresh:hover { color: #4fc3f7; }
    /* M8：缩略图样式 */
    .thumb-wrap { width: 80px; height: 60px; display: flex; align-items: center; justify-content: center; background: #0f1620; border-radius: 3px; overflow: hidden; }
    .thumb-wrap img.thumb-img { max-width: 80px; max-height: 60px; object-fit: contain; display: block; }
    .thumb-wrap a { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; cursor: zoom-in; }
    .thumb-wrap a:hover img.thumb-img { filter: brightness(1.1); }
    .thumb-wrap .thumb-loading { font-size: 10px; color: #8b95a7; }
    .thumb-wrap .thumb-err { font-size: 10px; color: #e57373; }
    .empty { color: #555; font-style: italic; padding: 12px; text-align: center; }
    code { color: #ffd54f; font-family: Consolas, monospace; font-size: 12px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .topbar-actions { display: flex; align-items: center; gap: 8px; }
    .service-links { display: flex; flex-wrap: wrap; gap: 6px; }
    .service-link { padding: 4px 8px; border: 1px solid #2a3142; border-radius: 4px; color: #8b95a7; font-size: 11px; text-decoration: none; }
    .service-link:hover { border-color: #4fc3f7; color: #4fc3f7; background: #1e3a4f; }
    .user-box { font-size: 12px; color: #8b95a7; }
    .user-box .name { color: #b39ddb; margin-right: 8px; }
    .user-box .role { background: #2a2a3d; color: #b39ddb; padding: 2px 6px; border-radius: 8px; font-size: 11px; margin-right: 12px; }
    .btn-logout { padding: 2px 10px; border-radius: 4px; border: 1px solid #e57373; background: transparent; color: #e57373; cursor: pointer; font-size: 11px; }
    .btn-logout:hover { background: #3f1e1e; }
    /* M5：图层绑定编辑器 */
    .modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 1000; display: none; align-items: center; justify-content: center; }
    .modal-mask.open { display: flex; }
    .modal { background: #0f1419; border: 1px solid #2a3142; border-radius: 8px; width: 92vw; max-width: 1200px; height: 86vh; display: flex; flex-direction: column; }
    .modal-header { padding: 12px 16px; border-bottom: 1px solid #2a3142; display: flex; justify-content: space-between; align-items: center; }
    .modal-header h3 { font-size: 15px; color: #4fc3f7; }
    .modal-header .meta { font-size: 11px; color: #8b95a7; margin-top: 2px; }
    .modal-body { flex: 1; display: flex; overflow: hidden; }
    .modal-left { width: 42%; border-right: 1px solid #2a3142; overflow-y: auto; padding: 8px; }
    .modal-right { flex: 1; overflow-y: auto; padding: 16px; }
    .modal-footer { padding: 10px 16px; border-top: 1px solid #2a3142; display: flex; justify-content: space-between; align-items: center; }
    .layer-node { padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; }
    .layer-node:hover { background: #1a1f2e; }
    .layer-node.selected { background: #1e3a4f; }
    .layer-node .name { color: #e6e6e6; }
    .layer-node .type { font-size: 10px; color: #8b95a7; background: #2a3142; padding: 1px 5px; border-radius: 8px; }
    .layer-node .bound { color: #81c784; font-size: 10px; margin-left: auto; }
    .layer-children { margin-left: 14px; border-left: 1px dashed #2a3142; padding-left: 4px; }
    .form-row { margin-bottom: 12px; }
    .form-row label { display: block; font-size: 11px; color: #8b95a7; margin-bottom: 4px; }
    .form-row input, .form-row select, .form-row textarea { width: 100%; padding: 6px 8px; background: #1a1f2e; border: 1px solid #2a3142; border-radius: 4px; color: #e6e6e6; font-size: 13px; font-family: inherit; }
    .form-row input:focus, .form-row select:focus { outline: none; border-color: #4fc3f7; }
    .form-row .checkbox-row { display: flex; align-items: center; gap: 6px; }
    .form-row .checkbox-row input { width: auto; }
    .form-hint { font-size: 10px; color: #8b95a7; margin-top: 2px; }
    .empty-layer { padding: 24px; text-align: center; color: #8b95a7; }
    .btn-primary { padding: 6px 16px; border-radius: 4px; border: 1px solid #4fc3f7; background: #1e3a4f; color: #4fc3f7; cursor: pointer; font-size: 12px; }
    .btn-primary:hover { background: #2a4a5f; }
    .btn-secondary { padding: 6px 16px; border-radius: 4px; border: 1px solid #2a3142; background: transparent; color: #8b95a7; cursor: pointer; font-size: 12px; }
    .btn-secondary:hover { background: #1a1f2e; }
    .binding-summary { font-size: 12px; color: #b39ddb; }
    .license-modal { width: min(92vw, 520px); height: auto; }
    .license-modal .modal-body { display: block; padding: 16px; overflow: visible; }
    .license-modal textarea { min-height: 110px; resize: vertical; }
    /* Worker 详情弹框：内容超出时显示垂直滚动栏 */
    .worker-detail-modal { height: auto; max-height: 86vh; }
    .worker-detail-modal .modal-body { display: block; padding: 16px; overflow-y: auto; }
    /* Worker 详情页历史任务列表：限高约 10 条，超出通过滚动栏查看 */
    .worker-history-list { max-height: 360px; overflow-y: auto; border: 1px solid #2a3142; border-radius: 4px; }
    .worker-history-list::-webkit-scrollbar { width: 8px; }
    .worker-history-list::-webkit-scrollbar-thumb { background: #2a3142; border-radius: 4px; }
    .worker-history-list::-webkit-scrollbar-thumb:hover { background: #3a4152; }
    .worker-history-list { scrollbar-width: thin; scrollbar-color: #2a3142 transparent; }
    /* 限高滚动表格容器：单页展示约 10 条，其余通过滚动查看 */
    .scroll-table { max-height: 400px; overflow-y: auto; }
    .scroll-table table { width: 100%; border-collapse: collapse; }
    /* 隐藏滚动条但保留滚动能力（Chrome/Safari/Edge/Firefox） */
    .scroll-table::-webkit-scrollbar,
    .worker-detail-modal .modal-body::-webkit-scrollbar { width: 0; height: 0; display: none; }
    .scroll-table { scrollbar-width: none; -ms-overflow-style: none; }
    .worker-detail-modal .modal-body { scrollbar-width: none; -ms-overflow-style: none; }
    /* API Key 结果弹框：明文 key 展示 + 复制按钮 */
    .apikey-result-warn { background: #3d3520; border: 1px solid #ffd54f; color: #ffd54f; padding: 10px 12px; border-radius: 4px; font-size: 12px; margin-bottom: 12px; line-height: 1.6; }
    .apikey-result-box { display: flex; align-items: center; gap: 8px; background: #1a1f2e; border: 1px solid #2a3142; border-radius: 4px; padding: 10px 12px; }
    .apikey-result-box code { flex: 1; word-break: break-all; font-size: 13px; color: #81c784; user-select: all; }
    .apikey-copy-btn { padding: 4px 10px; border-radius: 4px; border: 1px solid #4fc3f7; background: #1e3a4f; color: #4fc3f7; cursor: pointer; font-size: 12px; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .apikey-copy-btn:hover { background: #2a4a5f; }
    .apikey-copy-btn.copied { border-color: #81c784; color: #81c784; background: #1e3f28; }
    .apikey-meta-row { display: flex; gap: 16px; margin-top: 10px; font-size: 12px; color: #8b95a7; }
    .apikey-meta-row strong { color: #b39ddb; margin-right: 4px; font-weight: 600; }
    .apikey-form-modal { width: min(92vw, 560px); height: auto; }
    .apikey-form-modal .modal-body { display: block; padding: 16px; overflow: visible; }
    /* Worker 注册配对码结果展示：大字号、居中、可选中复制 */
    .bootstrap-code-box { text-align: center; padding: 20px 0; }
    .bootstrap-code-box .code { display: inline-block; font-size: 36px; font-weight: 700; color: #81c784; font-family: Consolas, monospace; letter-spacing: 4px; user-select: all; padding: 16px 28px; background: #1a1f2e; border: 1px solid #2a3142; border-radius: 6px; }
    .bootstrap-result-box { display: flex; align-items: center; gap: 8px; background: #1a1f2e; border: 1px solid #2a3142; border-radius: 4px; padding: 10px 12px; }
    .bootstrap-result-box code { flex: 1; word-break: break-all; font-size: 13px; color: #81c784; user-select: all; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1 style="margin-bottom:0">Photoshop渲染农场服务控制台 <span class="refresh" onclick="loadAll()">↻ 刷新</span></h1>
    <div class="topbar-actions">
      <nav class="service-links" aria-label="服务入口">
        <a class="service-link" href="/docs" target="_blank" rel="noopener noreferrer">API 文档</a>
        <a class="service-link" href="/docs/json" target="_blank" rel="noopener noreferrer">OpenAPI JSON</a>
        <a class="service-link" href="/health" target="_blank" rel="noopener noreferrer">健康检查</a>
        <a class="service-link" href="/metrics" target="_blank" rel="noopener noreferrer">监控指标</a>
      </nav>
      <div class="user-box" id="userBox" style="display:none">
        <span class="name" id="userName"></span>
        <span class="role" id="userRole"></span>
        <button class="btn-logout" onclick="doLogout()">退出</button>
      </div>
    </div>
  </div>

  <h2>概览</h2>
  <div class="stats" id="stats"><div class="empty">加载中...</div></div>

  <h2>告警 <span style="font-size:11px;color:#8b95a7;font-weight:normal;">（最近 100 条，滚动查看）</span> <button class="btn-act danger" style="float:right;margin-top:4px" onclick="batchClearAlerts()">批量清除告警日志</button></h2>
  <div class="scroll-table"><table id="alerts"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>Worker 节点</h2>
  <div class="scroll-table"><table id="workers"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>Worker 注册配对码 <button class="btn-act" style="float:right;margin-top:4px" onclick="bootstrapTokenCreate()">生成配对码</button></h2>
  <div class="scroll-table"><table id="bootstrapTokens"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>PSD 渲染测试</h2>
  <div class="stat" id="testRender"><div class="empty">加载中...</div></div>

  <h2>存储设置</h2>
  <div class="stat" id="storageSettings"><div class="empty">加载中...</div></div>

  <h2>最近任务 <span style="font-size:11px;color:#8b95a7;font-weight:normal;">（最近 30 条，滚动查看）</span> <div style="float:right;margin-top:4px;display:flex;gap:8px;"><button class="btn-act danger" onclick="batchDeleteJobs()">批量删除任务日志</button><button class="btn-act danger" onclick="batchCancel()">批量取消进行中任务</button></div></h2>
  <div class="scroll-table"><table id="jobs"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>模板 <button class="btn-act" style="float:right;margin-top:4px" onclick="openTemplateUpload()">上传 PSD 模板</button></h2>
  <div class="scroll-table"><table id="templates"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>字体 <button class="btn-act" style="float:right;margin-top:4px" onclick="openFontUpload()">上传字体</button></h2>
  <div class="scroll-table"><table id="fonts"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>API Key <span style="font-size:11px;color:#8b95a7;font-weight:normal;">（调用方密钥）</span> <button class="btn-act" style="float:right;margin-top:4px" onclick="apiKeyCreate()">+ 新建 API Key</button></h2>
  <div class="scroll-table"><table id="apiKeys"><tr><td class="empty">加载中...</td></tr></table></div>

  <h2>Webhook 投递日志 <span style="font-size:11px;color:#8b95a7;font-weight:normal;">（最近 50 条，含重试状态，滚动查看）</span></h2>
  <div class="scroll-table"><table id="webhookLogs"><tr><td class="empty">加载中...</td></tr></table></div>

  <!-- M5：图层绑定编辑模态框 -->
  <div class="modal-mask" id="bindingModal">
    <div class="modal">
      <div class="modal-header">
        <div>
          <h3 id="bindingModalTitle">图层绑定配置</h3>
          <div class="meta" id="bindingModalMeta"></div>
        </div>
        <button class="btn-secondary" onclick="closeBindingEditor()">关闭</button>
      </div>
      <div class="modal-body">
        <div class="modal-left" id="bindingLayerTree"></div>
        <div class="modal-right" id="bindingEditor"><div class="empty-layer">请从左侧选择一个图层</div></div>
      </div>
      <div class="modal-footer">
        <div class="binding-summary" id="bindingSummary"></div>
        <div>
          <button class="btn-secondary" onclick="closeBindingEditor()">取消</button>
          <button class="btn-primary" onclick="saveBindings()">保存绑定</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-mask" id="licenseModal">
    <div class="modal license-modal">
      <div class="modal-header">
        <h3>编辑字体许可证</h3>
        <button class="btn-secondary" onclick="closeLicenseEditor()">关闭</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label for="licenseNoteInput">许可证备注</label>
          <textarea id="licenseNoteInput" maxlength="500" placeholder="请输入许可证备注，留空则清除"></textarea>
          <div class="form-hint">最多 500 个字符</div>
        </div>
      </div>
      <div class="modal-footer">
        <span class="form-hint" id="licenseEditorStatus"></span>
        <div>
          <button class="btn-secondary" onclick="closeLicenseEditor()">取消</button>
          <button class="btn-primary" id="licenseEditorSave" onclick="saveLicenseEditor()">保存</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-mask" id="workerNameModal">
    <div class="modal license-modal"><div class="modal-header"><h3>编辑 Worker 节点名称</h3><button class="btn-secondary" onclick="closeWorkerNameEditor()">关闭</button></div><div class="modal-body"><div class="form-row"><label>节点名称</label><input id="workerNameInput" maxlength="100" /></div><div id="workerNameStatus" class="form-hint"></div></div><div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeWorkerNameEditor()">取消</button><button class="btn-primary" id="workerNameSave" onclick="saveWorkerNameEditor()">保存</button></div></div></div>
  </div>

  <div class="modal-mask" id="workerCodeModal">
    <div class="modal license-modal"><div class="modal-header"><h3>编辑 Worker 自定义编号</h3><button class="btn-secondary" onclick="closeWorkerCodeEditor()">关闭</button></div><div class="modal-body"><div class="form-row"><label>自定义编号</label><input id="workerCodeInput" maxlength="50" placeholder="留空清除自定义编号" /><div class="form-hint">1-50 字符，仅支持字母、数字、下划线、中划线、中文；同一节点唯一</div></div><div id="workerCodeStatus" class="form-hint"></div></div><div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeWorkerCodeEditor()">取消</button><button class="btn-primary" id="workerCodeSave" onclick="saveWorkerCodeEditor()">保存</button></div></div></div>
  </div>

  <div class="modal-mask" id="workerDetailModal">
    <div class="modal license-modal worker-detail-modal" style="max-width: 720px;"><div class="modal-header"><h3>Worker 节点详情</h3></div><div class="modal-body" id="workerDetailBody"><div class="form-hint">加载中...</div></div><div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeWorkerDetail()">关闭</button></div></div></div>
  </div>

  <div class="modal-mask" id="templateUploadModal">
    <div class="modal license-modal"><div class="modal-header"><h3>上传 PSD 模板</h3><button class="btn-secondary" onclick="closeTemplateUpload()">关闭</button></div><div class="modal-body"><div class="form-row"><label>模板名称</label><input id="templateUploadName" maxlength="100" /></div><div class="form-row"><label>PSD 文件</label><input id="templateUploadFile" type="file" accept=".psd,image/vnd.adobe.photoshop" /></div><div class="form-row"><label>最低 Photoshop 版本</label><input id="templateUploadPsVersion" value="25.0" maxlength="20" /></div><div class="form-hint" id="templateUploadStatus"></div></div><div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeTemplateUpload()">取消</button><button class="btn-primary" id="templateUploadSave" onclick="submitTemplateUpload()">上传并解析</button></div></div></div>
  </div>

  <div class="modal-mask" id="confirmModal">
    <div class="modal license-modal"><div class="modal-header"><h3>确认操作</h3></div><div class="modal-body"><div id="confirmMessage"></div></div><div class="modal-footer"><span></span><div><button class="btn-secondary" id="confirmCancel">取消</button><button class="btn-primary" id="confirmAccept">确定</button></div></div></div>
  </div>

  <!-- API Key 创建/编辑表单弹框（替代浏览器 prompt 链） -->
  <div class="modal-mask" id="apiKeyFormModal">
    <div class="modal apikey-form-modal">
      <div class="modal-header"><h3 id="apiKeyFormTitle">新建 API Key</h3><button class="btn-secondary" onclick="closeApiKeyForm()">关闭</button></div>
      <div class="modal-body">
        <div class="form-row"><label for="apiKeyFormName">名称 *</label><input id="apiKeyFormName" maxlength="100" placeholder="如：调用方A" /><div class="form-hint">1-100 字符</div></div>
        <div class="form-row"><label for="apiKeyFormPriority">优先级</label><input id="apiKeyFormPriority" type="number" min="1" max="10" value="5" /><div class="form-hint">1-10，数字越小优先级越高（默认 5）</div></div>
        <div class="form-row"><label for="apiKeyFormRateLimit">每分钟限流次数</label><input id="apiKeyFormRateLimit" type="number" min="1" placeholder="留空不限制" /><div class="form-hint">留空表示不限制</div></div>
        <div class="form-row"><label for="apiKeyFormQuota">每日配额次数</label><input id="apiKeyFormQuota" type="number" min="1" placeholder="留空不限制" /><div class="form-hint">留空表示不限制</div></div>
        <div class="form-row"><label for="apiKeyFormScopes">作用域</label><input id="apiKeyFormScopes" placeholder="逗号分隔，留空表示全部权限，如：jobs:create,jobs:read" /><div class="form-hint">逗号分隔，留空表示全部权限</div></div>
        <div class="form-row"><label for="apiKeyFormIpWhitelist">IP 白名单</label><input id="apiKeyFormIpWhitelist" placeholder="逗号分隔 CIDR 或 IP，留空不限制" /><div class="form-hint">逗号分隔 CIDR 或 IP，留空不限制</div></div>
        <div class="form-row"><label for="apiKeyFormWebhookUrl">默认 Webhook URL</label><input id="apiKeyFormWebhookUrl" placeholder="留空不设置" /><div class="form-hint">留空不设置</div></div>
        <div class="form-hint" id="apiKeyFormStatus" style="color:#e57373;margin-top:8px"></div>
      </div>
      <div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeApiKeyForm()">取消</button><button class="btn-primary" id="apiKeyFormSave" onclick="submitApiKeyForm()">保存</button></div></div>
    </div>
  </div>

  <!-- API Key 创建/轮换结果弹框（替代浏览器 alert，含复制图标） -->
  <div class="modal-mask" id="apiKeyResultModal">
    <div class="modal apikey-form-modal">
      <div class="modal-header"><h3 id="apiKeyResultTitle">API Key 创建成功</h3><button class="btn-secondary" onclick="closeApiKeyResult()">关闭</button></div>
      <div class="modal-body">
        <div class="apikey-result-warn" id="apiKeyResultWarn">⚠ 此明文 Key 仅显示一次，请立即复制并妥善保存。关闭后将无法再次获取，遗失需重新生成或轮换。</div>
        <div class="form-row"><label>明文 API Key</label>
          <div class="apikey-result-box">
            <code id="apiKeyResultPlaintext"></code>
            <button class="apikey-copy-btn" id="apiKeyResultCopyBtn" onclick="copyApiKeyResult()" title="点击复制"><span>📋</span><span id="apiKeyResultCopyText">复制</span></button>
          </div>
        </div>
        <div class="apikey-meta-row"><span><strong>名称：</strong><span id="apiKeyResultName"></span></span><span><strong>前缀：</strong><code id="apiKeyResultPrefix"></code></span></div>
      </div>
      <div class="modal-footer"><span></span><div><button class="btn-primary" onclick="closeApiKeyResult()">我已保存，关闭</button></div></div>
    </div>
  </div>

  <!-- Worker 注册配对码生成模态框 -->
  <div class="modal-mask" id="bootstrapTokenCreateModal">
    <div class="modal apikey-form-modal">
      <div class="modal-header"><h3>生成 Worker 注册配对码</h3><button class="btn-secondary" onclick="closeBootstrapTokenCreate()">关闭</button></div>
      <div class="modal-body">
        <div class="form-row">
          <label for="bootstrapTokenNote">备注（可选）</label>
          <input id="bootstrapTokenNote" maxlength="200" placeholder="如：渲染节点A首次注册" />
          <div class="form-hint">最多 200 个字符，便于后续识别该配对码的用途</div>
        </div>
        <div class="form-hint" id="bootstrapTokenCreateStatus" style="color:#e57373;margin-top:8px"></div>
      </div>
      <div class="modal-footer"><span></span><div><button class="btn-secondary" onclick="closeBootstrapTokenCreate()">取消</button><button class="btn-primary" id="bootstrapTokenCreateSave" onclick="bootstrapTokenSubmit()">生成</button></div></div>
    </div>
  </div>

  <!-- Worker 注册配对码结果模态框（大字号展示，提示立即在 Worker UI 中使用） -->
  <div class="modal-mask" id="bootstrapTokenResultModal">
    <div class="modal apikey-form-modal">
      <div class="modal-header"><h3>配对码已生成</h3><button class="btn-secondary" onclick="closeBootstrapTokenResult()">关闭</button></div>
      <div class="modal-body">
        <div class="apikey-result-warn">请立即在 Worker UI 的"首次注册"中输入此配对码。配对码 24 小时内有效，仅可使用一次。</div>
        <div class="bootstrap-code-box">
          <span class="code" id="bootstrapTokenResultCode"></span>
        </div>
        <div class="form-row">
          <div class="bootstrap-result-box">
            <code id="bootstrapTokenResultCodeText"></code>
            <button class="apikey-copy-btn" id="bootstrapTokenResultCopyBtn" onclick="copyBootstrapTokenResult()" title="点击复制"><span>📋</span><span id="bootstrapTokenResultCopyText">复制</span></button>
          </div>
        </div>
      </div>
      <div class="modal-footer"><span></span><div><button class="btn-primary" onclick="closeBootstrapTokenResult()">我已使用，关闭</button></div></div>
    </div>
  </div>

  <script>
    // 统一 fetch：401 跳转登录页
    async function fetchJSON(url, opts) {
      const r = await fetch(url, opts);
      if (r.status === 401) {
        window.location.href = '/admin/login';
        return new Promise(() => {});
      }
      return r.json();
    }
    function fmtDate(d) {
      if (!d) return '-';
      const dt = new Date(d);
      return dt.toLocaleString('zh-CN', { hour12: false });
    }

    // ===== 中英文映射（保留 CSS class 用英文枚举，仅展示文本中文化） =====
    const ALERT_SEVERITY_LABEL = { INFO: '信息', WARN: '警告', ERROR: '错误', CRITICAL: '严重' };
    const ALERT_STATUS_LABEL = { ACTIVE: '活跃', ACKED: '已确认', RESOLVED: '已解决' };
    // 告警类型中文化：保留原英文 type 用于 CSS class，仅展示文本翻译
    const ALERT_TYPE_LABEL = {
      worker_offline: 'Worker 离线',
      job_failed_rate: '任务失败率',
      queue_backlog: '队列堆积',
      ps_stuck: 'PS 卡死',
      lease_expired: '租约超时',
      font_sync_failed: '字体同步失败',
    };
    const JOB_STATUS_LABEL = {
      QUEUED: '排队中', LEASED: '已领取', PROCESSING: '处理中',
      SUCCEEDED: '成功', FAILED: '失败',
      CANCELLED: '已取消', CANCELLING: '取消中',
    };
    const JOB_STAGE_LABEL = {
      DOWNLOAD: '下载素材', RUN_JSX: '执行脚本', UPLOAD: '上传结果',
    };
    function alertSeverityLabel(s) { return ALERT_SEVERITY_LABEL[s] || s; }
    function alertStatusLabel(s) { return ALERT_STATUS_LABEL[s] || s; }
    function alertTypeLabel(s) { return ALERT_TYPE_LABEL[s] || s; }
    function jobStatusLabel(s) { return JOB_STATUS_LABEL[s] || s; }
    function jobStageLabel(s) { return s ? (JOB_STAGE_LABEL[s] || s) : '-'; }

    function showConfirm(message) {
      return new Promise(resolve => {
        const modal = document.getElementById('confirmModal');
        const accept = document.getElementById('confirmAccept');
        const cancel = document.getElementById('confirmCancel');
        document.getElementById('confirmMessage').textContent = message;
        const finish = result => {
          modal.classList.remove('open');
          accept.onclick = null;
          cancel.onclick = null;
          resolve(result);
        };
        accept.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        modal.classList.add('open');
      });
    }

    async function loadMe() {
      try {
        const { user } = await fetchJSON('/admin/api/me');
        if (user) {
          document.getElementById('userBox').style.display = 'flex';
          document.getElementById('userName').textContent = user.username;
          document.getElementById('userRole').textContent = user.role;
        }
      } catch (e) { /* 忽略 */ }
    }

    async function doLogout() {
      if (!await showConfirm('确定要退出登录吗？')) return;
      await fetch('/admin/api/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    }

    async function loadStats() {
      const s = await fetchJSON('/admin/api/stats');
      document.getElementById('stats').innerHTML = \`
        <div class="stat"><div class="label">Worker 节点</div><div class="value">\${s.workers}</div></div>
        <div class="stat"><div class="label">模板</div><div class="value">\${s.templates}</div></div>
        <div class="stat"><div class="label">字体</div><div class="value">\${s.fonts}</div></div>
        <div class="stat queued"><div class="label">排队中</div><div class="value">\${s.jobs.queued}</div></div>
        <div class="stat processing"><div class="label">处理中</div><div class="value">\${s.jobs.processing}</div></div>
        <div class="stat succeeded"><div class="label">成功</div><div class="value">\${s.jobs.succeeded}</div></div>
        <div class="stat failed"><div class="label">失败</div><div class="value">\${s.jobs.failed}</div></div>
      \`;
    }

    let workersById = new Map();
    async function loadWorkers() {
      const { workers } = await fetchJSON('/admin/api/workers');
      workersById = new Map(workers.map(w => [w.workerId, w]));
      if (!workers.length) { document.getElementById('workers').innerHTML = '<tr><td class="empty">暂无 Worker</td></tr>'; return; }
      document.getElementById('workers').innerHTML = \`
        <thead><tr><th>名称</th><th>编号</th><th>状态</th><th>PS 版本</th><th>设备</th><th>IP</th><th>当前任务</th><th>字体哈希</th><th>最后心跳</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>
        \${workers.map(w => \`<tr>
          <td>\${escapeHtml(w.displayName || '-')}</td>
          <td><code>\${escapeHtml(w.customCode || w.code)}</code></td>
          <td><span class="badge \${w.status === 'IDLE' || w.status === 'BUSY' ? 'online' : 'offline'}">\${escapeHtml(w.statusLabel)}</span><div class="form-hint">\${w.heartbeatAgeSec === null ? '未收到心跳' : w.heartbeatAgeSec + ' 秒前心跳'}</div></td>
          <td>\${escapeHtml(w.psVersion)}</td>
          <td>\${escapeHtml(w.hostname || w.osVersion || w.os || '-')}\${w.cpuModel ? '<div class="form-hint">' + escapeHtml(w.cpuModel) + '</div>' : ''}</td>
          <td>\${escapeHtml(w.registeredIp || '-')}<div class="form-hint">\${escapeHtml(w.os || '')}</div></td>
          <td>\${w.currentJob ? jobStageLabel(w.currentJob.stage) + ' ' + w.currentJob.progress + '%' : '-'}</td>
          <td><code>\${w.fontInventoryHash || '-'}</code></td>
          <td>\${fmtDate(w.lastHeartbeatAt)}</td>
          <td>\${fmtDate(w.registeredAt)}</td>
          <td class="ops">
            <button class="btn-act" onclick="workerViewDetail('\${w.workerId}')">详情</button>
            <button class="btn-act danger" onclick="workerForceOffline('\${w.workerId}')" \${!w.sessionActive ? 'disabled' : ''}>下线</button>
            <button class="btn-act" onclick="workerReapprove('\${w.workerId}')" \${w.sessionActive ? 'disabled' : ''}>重新批准</button>
            <button class="btn-act" onclick="workerEditName('\${w.workerId}')">改名</button>
            <button class="btn-act" onclick="workerEditCode('\${w.workerId}')">改编号</button>
            <button class="btn-act danger" onclick="workerDelete('\${w.workerId}')" \${w.sessionActive ? 'disabled' : ''}>删除</button>
          </td>
        </tr>\`).join('')}
        </tbody>\`;
    }

    let testTemplates = [];
    // 标记测试渲染表单是否正在使用（用户已选文件或正在提交），
    // 避免 5 秒定时 loadAll 重建 DOM 导致 file input 选中文件丢失。
    let testRenderInUse = false;
    let testRenderSubmitting = false;
    async function loadTestRender() {
      const container = document.getElementById('testRender');
      if (!container) return;
      // 用户已选文件或正在提交时跳过重建（file input 无法用 JS 重新赋值）
      if (testRenderSubmitting) return;
      if (testRenderInUse) {
        // 仍刷新 worker 列表/模板列表的下拉项，但不破坏 file input
        // 仅当下拉框存在时更新选项
        return;
      }
      const [templateResponse, workerResponse] = await Promise.all([fetchJSON('/admin/api/test/templates'), fetchJSON('/admin/api/workers')]);
      testTemplates = templateResponse.templates;
      const onlineWorkers = workerResponse.workers.filter(w => w.online);
      if (!testTemplates.length) { container.innerHTML = '<div class="empty">没有已发布并配置图层绑定的模板</div>'; return; }
      if (!onlineWorkers.length) { container.innerHTML = '<div class="empty">没有在线 Worker，无法提交指定节点测试</div>'; return; }
      const prevWorker = document.getElementById('testWorker')?.value;
      const prevFormat = document.getElementById('testOutputFormat')?.value;
      const prevTemplate = document.getElementById('testTemplate')?.value;
      container.innerHTML = '<div class="form-row"><label>模板版本</label><select id="testTemplate" onchange="renderTestBindings()">' + testTemplates.map(t => '<option value="' + escapeHtml(t.templateVersionId) + '">' + escapeHtml(t.name) + ' v' + t.version + '</option>').join('') + '</select></div>' +
        '<div class="form-row"><label>指定 Worker</label><select id="testWorker">' + onlineWorkers.map(w => { const wc = w.customCode || w.code; return '<option value="' + escapeHtml(w.workerId) + '">' + escapeHtml(w.displayName || wc) + ' (' + escapeHtml(wc) + ')</option>'; }).join('') + '</select></div>' +
        '<div class="form-row"><label>导出格式</label><select id="testOutputFormat"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="psd">PSD</option></select></div><div id="testBindings"></div><button class="btn-primary" onclick="submitTestRender()">提交到指定 Worker</button><div class="form-hint" id="testRenderStatus"></div>';
      if (prevTemplate && testTemplates.some(t => t.templateVersionId === prevTemplate)) document.getElementById('testTemplate').value = prevTemplate;
      if (prevWorker && onlineWorkers.some(w => w.workerId === prevWorker)) document.getElementById('testWorker').value = prevWorker;
      if (prevFormat) document.getElementById('testOutputFormat').value = prevFormat;
      renderTestBindings();
    }

    function renderTestBindings() {
      const template = testTemplates.find(t => t.templateVersionId === document.getElementById('testTemplate').value);
      const bindings = template?.layerSchema?.bindings || [];
      document.getElementById('testBindings').innerHTML = bindings.map(b => {
        const label = escapeHtml(b.label || b.bindingId) + (b.required ? ' *' : '');
        if (b.type === 'text') return '<div class="form-row"><label>' + label + '（文字）</label><textarea data-test-binding="' + escapeHtml(b.bindingId) + '" data-test-kind="text" maxlength="' + (b.maxLength || 10000) + '" oninput="testRenderInUse=true"></textarea></div>';
        return '<div class="form-row"><label>' + label + '（图片）</label><input data-test-binding="' + escapeHtml(b.bindingId) + '" data-test-kind="image" type="file" accept="image/png,image/jpeg,image/webp" onchange="testRenderInUse=true" /></div>';
      }).join('') || '<div class="empty">该模板未配置可替换图层</div>';
    }

    async function submitTestRender() {
      const status = document.getElementById('testRenderStatus');
      const input = {};
      const fields = Array.from(document.querySelectorAll('[data-test-binding]'));
      testRenderSubmitting = true;
      status.textContent = '正在准备测试资源...';
      try {
        for (const field of fields) {
          const id = field.dataset.testBinding;
          if (field.dataset.testKind === 'text') {
            const text = field.value;
            if (text) input[id] = { text };
          } else if (field.files && field.files[0]) {
            const file = field.files[0];
            const response = await fetch('/admin/api/test/assets?fileName=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || '图片上传失败');
            input[id] = { assetId: data.assetId };
          }
        }
        status.textContent = '正在提交给指定 Worker...';
        const result = await fetchJSON('/admin/api/test/render-jobs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ templateVersionId: document.getElementById('testTemplate').value, targetWorkerId: document.getElementById('testWorker').value, input, output: { format: document.getElementById('testOutputFormat').value } }) });
        if (!result.jobId) throw new Error(result.message || '创建测试任务失败');
        status.textContent = '测试任务已提交：' + result.jobId;
        // 提交成功后重置使用标记，允许下次刷新重建表单
        testRenderInUse = false;
        loadJobs();
      } catch (e) {
        status.textContent = '提交失败: ' + e.message;
      } finally {
        testRenderSubmitting = false;
      }
    }

    // 标记存储设置表单是否正在使用（用户已修改任一字段或正在保存），
    // 避免 5 秒定时 loadAll 重建 DOM 清空用户输入。
    let storageSettingsInUse = false;
    let storageSettingsSubmitting = false;
    async function loadStorageSettings() {
      const container = document.getElementById('storageSettings');
      if (!container) return;
      // 用户已修改字段或正在保存时跳过重建
      if (storageSettingsSubmitting) return;
      if (storageSettingsInUse) return;
      const config = await fetchJSON('/admin/api/storage-settings');
      container.innerHTML = \
        '<div class="form-row"><label>存储后端</label><select id="storageBackend" onchange="storageSettingsInUse=true"><option value="local">本地存储</option><option value="cos">腾讯云 COS</option></select></div>' +
        '<div class="form-row"><label>本地存储目录</label><input id="storageLocalDir" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>COS Bucket</label><input id="cosBucket" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>COS Region</label><input id="cosRegion" placeholder="ap-guangzhou" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>COS 内网域名</label><input id="cosDomain" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>预签名有效期（秒）</label><input id="cosExpires" type="number" min="60" max="604800" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>SecretId</label><input id="cosSecretId" type="password" placeholder="' + (config.hasCosSecretId ? '已配置，留空保持不变' : '必填') + '" oninput="storageSettingsInUse=true" /></div>' +
        '<div class="form-row"><label>SecretKey</label><input id="cosSecretKey" type="password" placeholder="' + (config.hasCosSecretKey ? '已配置，留空保持不变' : '必填') + '" oninput="storageSettingsInUse=true" /></div>' +
        '<button class="btn-primary" onclick="saveStorageSettings()">保存并应用</button> <button class="btn-secondary" onclick="testStorageSettings()">测试配置</button><div class="form-hint" id="storageSettingsStatus"></div>';
      document.getElementById('storageBackend').value = config.backend;
      document.getElementById('storageLocalDir').value = config.localStorageDir || '';
      document.getElementById('cosBucket').value = config.cosBucket || '';
      document.getElementById('cosRegion').value = config.cosRegion || '';
      document.getElementById('cosDomain').value = config.cosInternalDomain || '';
      document.getElementById('cosExpires').value = config.cosPresignExpiresSec || 900;
    }

    function storageSettingsPayload() {
      return { backend: document.getElementById('storageBackend').value, localStorageDir: document.getElementById('storageLocalDir').value.trim(), cosBucket: document.getElementById('cosBucket').value.trim(), cosRegion: document.getElementById('cosRegion').value.trim(), cosInternalDomain: document.getElementById('cosDomain').value.trim(), cosPresignExpiresSec: Number(document.getElementById('cosExpires').value), cosSecretId: document.getElementById('cosSecretId').value, cosSecretKey: document.getElementById('cosSecretKey').value };
    }

    async function saveStorageSettings() {
      const status = document.getElementById('storageSettingsStatus'); status.textContent = '保存中...';
      storageSettingsSubmitting = true;
      try {
        await fetchJSON('/admin/api/storage-settings', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(storageSettingsPayload()) });
        status.textContent = '已保存并应用';
        // 保存成功后重置使用标记，允许下次刷新重建表单以反映最新状态
        storageSettingsInUse = false;
        await loadStorageSettings();
      }
      catch (e) { status.textContent = '保存失败: ' + e.message; }
      finally { storageSettingsSubmitting = false; }
    }

    async function testStorageSettings() {
      const status = document.getElementById('storageSettingsStatus'); status.textContent = '测试中...';
      storageSettingsSubmitting = true;
      try { await fetchJSON('/admin/api/storage-settings/test', { method: 'POST' }); status.textContent = '当前配置可用'; }
      catch (e) { status.textContent = '测试失败: ' + e.message; }
      finally { storageSettingsSubmitting = false; }
    }

    async function loadJobs() {
      const { jobs } = await fetchJSON('/admin/api/jobs?limit=30');
      if (!jobs.length) { document.getElementById('jobs').innerHTML = '<tr><td class="empty">暂无任务</td></tr>'; return; }
      // 后端拉取 30 条用于批量取消覆盖范围；表格容器限高滚动，单页展示约 10 条，其余滚动查看
      document.getElementById('jobs').innerHTML = \`
        <thead><tr><th>任务编号</th><th>状态</th><th>模板</th><th>尝试</th><th>阶段</th><th>进度</th><th>Worker</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
        \${jobs.map(j => {
          const isActive = ['QUEUED','LEASED','PROCESSING','CANCELLING'].includes(j.status);
          const isLeased = ['LEASED','PROCESSING'].includes(j.status);
          const isFailed = j.status === 'FAILED';
          let ops = '-';
          if (isActive) {
            ops = '<button class="btn-act danger" onclick="jobForceCancel(\\'' + j.jobId + '\\')">强制取消</button>';
            if (isLeased) ops += '<button class="btn-act warn" onclick="jobReleaseLease(\\'' + j.jobId + '\\')">释放租约</button>';
          } else if (isFailed) {
            ops = '<button class="btn-act" onclick="jobRetry(\\'' + j.jobId + '\\')">重试</button>';
          }
          // Worker 显示：优先自定义编号，回落到系统编号；鼠标悬停显示节点名称
          const workerCode = j.workerCustomCode || j.worker;
          const workerCell = workerCode
            ? '<code title="' + escapeHtml(j.workerDisplayName || j.worker || '') + '">' + escapeHtml(workerCode) + '</code>'
            : '<span style="color:#777">-</span>';
          return \`<tr>
            <td><code>\${escapeHtml(j.jobId)}</code></td>
            <td><span class="badge \${j.status}">\${jobStatusLabel(j.status)}</span></td>
            <td>\${escapeHtml(j.template)}</td>
            <td>\${j.attempt}/\${j.maxAttempts ?? 3}</td>
            <td>\${jobStageLabel(j.stage)}</td>
            <td>\${j.progress}%</td>
            <td>\${workerCell}</td>
            <td>\${fmtDate(j.createdAt)}</td>
            <td class="ops">\${ops}</td>
          </tr>\`;
        }).join('')}
        </tbody>\`;
    }

    async function loadTemplates() {
      const { templates } = await fetchJSON('/admin/api/templates');
      if (!templates.length) { document.getElementById('templates').innerHTML = '<tr><td class="empty">暂无模板</td></tr>'; return; }
      document.getElementById('templates').innerHTML = \`
        <thead><tr><th>缩略图</th><th>编号</th><th>名称</th><th>状态</th><th>版本</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
        \${templates.map(t => {
          let ops = '';
          // M5：DRAFT 状态可编辑图层绑定
          if (t.status === 'DRAFT' || t.status === 'REPUBLISH_REQUIRED' || t.status === 'ARCHIVED') {
            ops += '<button class="btn-act" onclick="openBindingEditor(\\'' + t.templateId + '\\', \\'' + escapeHtml(t.name) + '\\')">编辑绑定</button>';
          }
          if (!t.published) ops += '<button class="btn-act" onclick="tplPublish(\\'' + t.templateId + '\\')">发布</button>';
          // DRAFT / REPUBLISH_REQUIRED / ARCHIVED 均允许删除（PUBLISHED 需先归档）
          if (t.status === 'DRAFT' || t.status === 'REPUBLISH_REQUIRED' || t.status === 'ARCHIVED') ops += '<button class="btn-act danger" onclick="tplDelete(\\'' + t.templateId + '\\')">删除</button>';
          else if (t.status === 'PUBLISHED') ops += '<button class="btn-act warn" onclick="tplArchive(\\'' + t.templateId + '\\')">编辑</button>';
          if (!ops) ops = '-';
          // M8：缩略图占位
          //   - 有 thumbnailObjectKey：异步加载缩略图 URL
          //   - 无 thumbnailObjectKey：显示"生成缩略图"按钮，便于为历史模板补齐缩略图
          //     （旧实现仅显示 "-"，用户无法从 UI 修复缺失的缩略图）
          const thumbCell = t.thumbnailObjectKey
            ? '<div class="thumb-wrap" data-tpl-id="' + t.templateId + '"><span class="thumb-loading">加载中...</span></div>'
            : '<div class="thumb-wrap" data-tpl-id="' + t.templateId + '"><button class="btn-act" style="padding:1px 6px;font-size:10px" onclick="regenThumbnail(\\'' + t.templateId + '\\')">生成缩略图</button></div>';
          return \`<tr>
            <td>\${thumbCell}</td>
            <td><code>\${escapeHtml(t.code)}</code></td>
            <td>\${escapeHtml(t.name)}</td>
            <td><span class="badge \${t.status}">\${t.statusLabel}</span></td>
            <td>v\${t.latestVersion}</td>
            <td>\${fmtDate(t.createdAt)}</td>
            <td class="ops">\${ops}</td>
          </tr>\`;
        }).join('')}
        </tbody>\`;
      // M8：异步加载每个模板的缩略图 URL
      for (const t of templates) {
        if (!t.thumbnailObjectKey) continue;
        loadThumbnail(t.templateId);
      }
    }

    // M8：缩略图加载失败的全局处理函数（避免 onerror 属性内嵌套引号导致转义混乱）
    // 修复：原仅显示"加载失败"，现提供"重新生成"按钮供用户修复丢失的缩略图
    window.thumbErr = function(el) {
      if (el && el.parentNode) {
        const tplId = el.parentNode.getAttribute('data-tpl-id');
        el.parentNode.innerHTML = '<span class="thumb-err">加载失败</span>' +
          (tplId ? '<button class="btn-act" style="margin-left:4px;padding:1px 4px;font-size:10px" onclick="regenThumbnail(\\'' + tplId + '\\')">重生</button>' : '');
      }
    };

    // M8：缩略图 URL 缓存，避免每次切换 tab 回到列表都重新请求后端
    //   后端 downloadUrl 有效期 1 小时，这里缓存 50 分钟（留 10 分钟余量）
    //   key=templateId, value={url, expiresAt}
    const thumbUrlCache = new Map();
    const THUMB_CACHE_TTL_MS = 50 * 60 * 1000;

    function renderThumbnail(wrap, downloadUrl) {
      // 缩略图可点击：在新标签页打开完整尺寸 PNG（downloadUrl 已是带签名的完整 URL）
      wrap.innerHTML = '<a href="' + downloadUrl + '" target="_blank" rel="noopener" title="点击新标签页查看完整尺寸"><img src="' + downloadUrl + '" alt="缩略图" class="thumb-img" loading="lazy" onerror="thumbErr(this)" /></a>';
    }

    // M8：异步获取模板缩略图 URL 并填充到对应单元格（带缓存）
    async function loadThumbnail(templateId) {
      const wrap = document.querySelector('.thumb-wrap[data-tpl-id="' + templateId + '"]');
      if (!wrap) return;
      // 命中缓存且未过期：直接渲染，避免重新请求后端
      const cached = thumbUrlCache.get(templateId);
      if (cached && cached.expiresAt > Date.now()) {
        renderThumbnail(wrap, cached.url);
        return;
      }
      // 显示加载中（仅在真正发请求时显示，避免缓存命中时也闪一下"加载中"）
      wrap.innerHTML = '<span class="thumb-loading">加载中...</span>';
      try {
        const r = await fetchJSON('/admin/api/templates/' + templateId + '/thumbnail-url');
        if (r && r.downloadUrl) {
          thumbUrlCache.set(templateId, { url: r.downloadUrl, expiresAt: Date.now() + THUMB_CACHE_TTL_MS });
          renderThumbnail(wrap, r.downloadUrl);
        } else {
          // 后端清空了丢失的 thumbnailObjectKey 时返回 404，显示"重新生成"按钮
          wrap.innerHTML = '<button class="btn-act" style="padding:1px 6px;font-size:10px" onclick="regenThumbnail(\\'' + templateId + '\\')">生成缩略图</button>';
        }
      } catch (e) {
        wrap.innerHTML = '<span class="thumb-err">失败</span>';
      }
    }

    // 重新生成缩略图（修复丢失的缩略图文件）
    async function regenThumbnail(templateId) {
      if (!await showConfirm('确定重新生成该模板的缩略图？将重新解析 PSD 文件并生成预览图。')) return;
      const wrap = document.querySelector('.thumb-wrap[data-tpl-id="' + templateId + '"]');
      if (wrap) wrap.innerHTML = '<span class="thumb-loading">生成中...</span>';
      try {
        const r = await fetchJSON('/admin/api/templates/' + templateId + '/regenerate-thumbnail', { method: 'POST' });
        if (r && r.ok) {
          // 生成成功：清除旧缓存，重新拉取新缩略图 URL
          thumbUrlCache.delete(templateId);
          await loadThumbnail(templateId);
        } else {
          throw new Error(r?.message || '生成失败');
        }
      } catch (e) {
        if (wrap) wrap.innerHTML = '<span class="thumb-err">失败</span><button class="btn-act" style="margin-left:4px;padding:1px 4px;font-size:10px" onclick="regenThumbnail(\\'' + templateId + '\\')">重试</button>';
        alert('缩略图重新生成失败: ' + (e.message || '未知错误'));
      }
    }

    async function loadFonts() {
      const { fonts } = await fetchJSON('/admin/api/fonts');
      if (!fonts || !fonts.length) { document.getElementById('fonts').innerHTML = '<tr><td class="empty">暂无字体</td></tr>'; return; }
      document.getElementById('fonts').innerHTML = \`
        <thead><tr><th>字体族</th><th>PostScript 名</th><th>样式</th><th>状态</th><th>许可证</th><th>SHA256</th><th>操作</th></tr></thead>
        <tbody>
        \${fonts.map(f => {
          const canPublish = f.licenseNote && f.licenseNote.trim();
          return \`<tr>
            <td>\${escapeHtml(f.familyName)}</td>
            <td><code>\${escapeHtml(f.postscriptName)}</code></td>
            <td>\${escapeHtml(f.style)}</td>
            <td><span class="badge \${f.published ? 'SUCCEEDED' : 'FAILED'}">\${f.published ? '已启用' : '已禁用'}</span></td>
            <td>\${f.licenseNote ? '<span style="color:#b39ddb">'+escapeHtml(f.licenseNote)+'</span>' : '<span style="color:#e57373" title="M9：未设置许可证备注的字体不能启用">⚠ 未设置</span>'}</td>
            <td><code title="\${escapeHtml(f.sha256)}">\${escapeHtml(f.sha256.slice(0,8))}...</code></td>
            <td class="ops">
              <button class="btn-act \${f.published ? 'warn' : ''}" onclick="fontToggle('\${f.fontId}', \${!f.published})" \${(!f.published && !canPublish) ? 'disabled title="请先编辑许可证备注再启用"' : ''}>\${f.published ? '禁用' : '启用'}</button>
              <button class="btn-act" onclick="fontEditLicense('\${f.fontId}', '\${escapeHtml(f.licenseNote || '')}')">编辑许可证</button>
              <button class="btn-act danger" onclick="fontDelete('\${f.fontId}', '\${escapeHtml(f.familyName || '')}', '\${escapeHtml(f.postscriptName || '')}')">删除</button>
            </td>
          </tr>\`;
        }).join('')}
        </tbody>\`;
    }

    function escapeHtml(s) {
      return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    }

    // ===== API Key 管理 =====
    let apiKeysById = new Map();

    async function loadApiKeys() {
      const { apiKeys } = await fetchJSON('/admin/api/api-keys');
      apiKeysById = new Map(apiKeys.map(k => [k.id, k]));
      if (!apiKeys || !apiKeys.length) { document.getElementById('apiKeys').innerHTML = '<tr><td class="empty">暂无 API Key</td></tr>'; return; }
      document.getElementById('apiKeys').innerHTML = \`
        <thead><tr><th>名称</th><th>状态</th><th>前缀</th><th>优先级</th><th>限流/分</th><th>日配额</th><th>作用域</th><th>IP 白名单</th><th>最近使用</th><th>操作</th></tr></thead>
        <tbody>
        \${apiKeys.map(k => {
          const quota = k.quotaPerDay ? k.quotaUsedDay + '/' + k.quotaPerDay : '-';
          const scopes = (k.scopes && k.scopes.length) ? k.scopes.map(s => '<code>'+escapeHtml(s)+'</code>').join(' ') : '<span style="color:#8b95a7">全部</span>';
          let ops = '';
          if (k.active) {
            ops += '<button class="btn-act warn" onclick="apiKeyRotate(\\'' + k.id + '\\')">轮换</button>';
            ops += '<button class="btn-act warn" onclick="apiKeyDisable(\\'' + k.id + '\\')">禁用</button>';
            if (k.quotaPerDay) ops += '<button class="btn-act" onclick="apiKeyResetQuota(\\'' + k.id + '\\')">重置配额</button>';
            ops += '<button class="btn-act" onclick="apiKeyEdit(\\'' + k.id + '\\')">编辑</button>';
          } else {
            ops += '<button class="btn-act" onclick="apiKeyEnable(\\'' + k.id + '\\')">启用</button>';
          }
          ops += '<button class="btn-act danger" onclick="apiKeyDelete(\\'' + k.id + '\\')">删除</button>';
          return \`<tr>
            <td>\${escapeHtml(k.name)}</td>
            <td><span class="badge \${k.active ? 'SUCCEEDED' : 'FAILED'}">\${k.active ? '启用' : '禁用'}</span></td>
            <td><code title="前缀可用于识别">\${escapeHtml(k.keyPrefix)}...</code></td>
            <td>\${k.priority}</td>
            <td>\${k.rateLimitPerMin || '-'}</td>
            <td>\${quota}</td>
            <td>\${scopes}</td>
            <td>\${k.ipWhitelist ? '<code>'+escapeHtml(k.ipWhitelist)+'</code>' : '-'}</td>
            <td>\${fmtDate(k.lastUsedAt)}</td>
            <td class="ops">\${ops}</td>
          </tr>\`;
        }).join('')}
        </tbody>\`;
    }

    // 当前表单编辑态：null=新建，string=编辑对应 id
    let apiKeyFormEditId = null;

    function apiKeyCreate() {
      apiKeyFormEditId = null;
      document.getElementById('apiKeyFormTitle').textContent = '新建 API Key';
      document.getElementById('apiKeyFormName').value = '';
      document.getElementById('apiKeyFormPriority').value = '5';
      document.getElementById('apiKeyFormRateLimit').value = '';
      document.getElementById('apiKeyFormQuota').value = '';
      document.getElementById('apiKeyFormScopes').value = '';
      document.getElementById('apiKeyFormIpWhitelist').value = '';
      document.getElementById('apiKeyFormWebhookUrl').value = '';
      document.getElementById('apiKeyFormStatus').textContent = '';
      document.getElementById('apiKeyFormSave').disabled = false;
      document.getElementById('apiKeyFormModal').classList.add('open');
    }

    function apiKeyEdit(id) {
      const k = apiKeysById.get(id);
      if (!k) return;
      apiKeyFormEditId = id;
      document.getElementById('apiKeyFormTitle').textContent = '编辑 API Key';
      document.getElementById('apiKeyFormName').value = k.name || '';
      document.getElementById('apiKeyFormPriority').value = String(k.priority ?? 5);
      document.getElementById('apiKeyFormRateLimit').value = k.rateLimitPerMin ? String(k.rateLimitPerMin) : '';
      document.getElementById('apiKeyFormQuota').value = k.quotaPerDay ? String(k.quotaPerDay) : '';
      document.getElementById('apiKeyFormScopes').value = (k.scopes || []).join(',');
      document.getElementById('apiKeyFormIpWhitelist').value = k.ipWhitelist || '';
      document.getElementById('apiKeyFormWebhookUrl').value = k.webhookUrlDefault || '';
      document.getElementById('apiKeyFormStatus').textContent = '';
      document.getElementById('apiKeyFormSave').disabled = false;
      document.getElementById('apiKeyFormModal').classList.add('open');
    }

    function closeApiKeyForm() {
      document.getElementById('apiKeyFormModal').classList.remove('open');
    }

    // 从表单读取并组装请求体（新建/编辑共用）
    function readApiKeyFormBody() {
      const name = document.getElementById('apiKeyFormName').value.trim();
      const priorityRaw = document.getElementById('apiKeyFormPriority').value.trim();
      const priority = parseInt(priorityRaw || '5', 10);
      const rateLimit = document.getElementById('apiKeyFormRateLimit').value.trim();
      const quota = document.getElementById('apiKeyFormQuota').value.trim();
      const scopesRaw = document.getElementById('apiKeyFormScopes').value.trim();
      const ipWhitelist = document.getElementById('apiKeyFormIpWhitelist').value.trim();
      const webhookUrl = document.getElementById('apiKeyFormWebhookUrl').value.trim();
      return {
        name,
        priority: isNaN(priority) ? 5 : priority,
        rateLimitPerMin: rateLimit ? parseInt(rateLimit, 10) : null,
        quotaPerDay: quota ? parseInt(quota, 10) : null,
        scopes: scopesRaw ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
        ipWhitelist: ipWhitelist || null,
        webhookUrlDefault: webhookUrl || null,
      };
    }

    async function submitApiKeyForm() {
      const status = document.getElementById('apiKeyFormStatus');
      const button = document.getElementById('apiKeyFormSave');
      const body = readApiKeyFormBody();
      if (!body.name) { status.textContent = '请填写名称'; return; }
      button.disabled = true;
      status.textContent = '';
      try {
        if (apiKeyFormEditId) {
          await fetchJSON('/admin/api/api-keys/'+apiKeyFormEditId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          closeApiKeyForm();
          loadApiKeys();
        } else {
          const r = await fetchJSON('/admin/api/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          closeApiKeyForm();
          loadApiKeys();
          if (r && r.plaintextKey) {
            showApiKeyResult('API Key 创建成功', r.plaintextKey, r.apiKey);
          }
        }
      } catch (e) {
        status.textContent = '保存失败: ' + (e && e.message ? e.message : e);
      } finally {
        button.disabled = false;
      }
    }

    // 展示明文 key 结果弹框（替代 alert）
    function showApiKeyResult(title, plaintext, apiKey) {
      document.getElementById('apiKeyResultTitle').textContent = title;
      document.getElementById('apiKeyResultPlaintext').textContent = plaintext;
      document.getElementById('apiKeyResultName').textContent = apiKey?.name || '-';
      document.getElementById('apiKeyResultPrefix').textContent = (apiKey?.keyPrefix || '') + '...';
      // 重置复制按钮文案
      const btn = document.getElementById('apiKeyResultCopyBtn');
      btn.classList.remove('copied');
      document.getElementById('apiKeyResultCopyText').textContent = '复制';
      document.getElementById('apiKeyResultModal').classList.add('open');
    }

    function closeApiKeyResult() {
      document.getElementById('apiKeyResultModal').classList.remove('open');
    }

    // 复制明文 key 到剪贴板，点击复制图标即复制
    async function copyApiKeyResult() {
      const text = document.getElementById('apiKeyResultPlaintext').textContent;
      const btn = document.getElementById('apiKeyResultCopyBtn');
      const label = document.getElementById('apiKeyResultCopyText');
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        // 降级：选中文本并尝试 execCommand
        try {
          const range = document.createRange();
          range.selectNode(document.getElementById('apiKeyResultPlaintext'));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          ok = document.execCommand('copy');
          sel.removeAllRanges();
        } catch (e2) { ok = false; }
      }
      if (ok) {
        btn.classList.add('copied');
        label.textContent = '已复制';
      } else {
        label.textContent = '复制失败，请手动选择';
      }
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = '复制';
      }, 2000);
    }

    async function apiKeyRotate(id) {
      if (!await showConfirm('确定轮换该 API Key？旧 Key 将立即失效，新 Key 仅显示一次。')) return;
      try {
        const r = await fetchJSON('/admin/api/api-keys/'+id+'/rotate', { method: 'POST' });
        loadApiKeys();
        if (r && r.plaintextKey) {
          showApiKeyResult('API Key 轮换成功', r.plaintextKey, r.apiKey);
        }
      } catch (e) { alert('轮换失败: ' + e.message); }
    }

    async function apiKeyDisable(id) {
      if (!await showConfirm('确定禁用该 API Key？禁用后调用方请求将立即被拒绝。')) return;
      try {
        await fetchJSON('/admin/api/api-keys/'+id+'/disable', { method: 'POST' });
        loadApiKeys();
      } catch (e) { alert('禁用失败: ' + e.message); }
    }

    async function apiKeyEnable(id) {
      if (!await showConfirm('确定启用该 API Key？')) return;
      try {
        await fetchJSON('/admin/api/api-keys/'+id+'/enable', { method: 'POST' });
        loadApiKeys();
      } catch (e) { alert('启用失败: ' + e.message); }
    }

    async function apiKeyResetQuota(id) {
      if (!await showConfirm('确定重置该 API Key 的日配额计数？')) return;
      try {
        await fetchJSON('/admin/api/api-keys/'+id+'/reset-quota', { method: 'POST' });
        loadApiKeys();
      } catch (e) { alert('重置失败: ' + e.message); }
    }

    async function apiKeyDelete(id) {
      if (!await showConfirm('确定彻底删除该 API Key？此操作不可恢复，关联任务将解除引用。建议改为禁用。')) return;
      if (!await showConfirm('再次确认：彻底删除 API Key？')) return;
      try {
        await fetchJSON('/admin/api/api-keys/'+id, { method: 'DELETE' });
        loadApiKeys();
      } catch (e) { alert('删除失败: ' + e.message); }
    }

    // ===== 操作函数 =====
    async function workerForceOffline(id) {
      if (!await showConfirm('确定强制下线该 Worker？')) return;
      await fetchJSON('/admin/api/workers/'+id+'/force-offline', { method: 'POST' });
      loadWorkers();
    }
    async function workerReapprove(id) {
      if (!await showConfirm('确定重新批准该 Worker？')) return;
      await fetchJSON('/admin/api/workers/'+id+'/reapprove', { method: 'POST' });
      loadWorkers();
    }
    // 第四期 M9：删除 Worker 节点（需先下线且无进行中任务）
    async function workerDelete(id) {
      const w = workersById.get(id);
      const label = w ? (w.displayName || w.code) : id;
      if (!await showConfirm('确定删除 Worker 节点 "' + label + '"？\\n\\n注意：\\n• 仅离线且无进行中任务的 Worker 可删除\\n• 历史任务的 Worker 关联会被清空\\n• 此操作不可恢复')) return;
      try {
        const res = await fetchJSON('/admin/api/workers/'+id, { method: 'DELETE' });
        loadWorkers();
        alert('已删除 Worker: ' + res.code);
      } catch (e) {
        alert('删除失败: ' + (e.message || e.error || '未知错误'));
      }
    }
    // 第四期 M9：查看 Worker 详情（含硬件画像、历史任务列表）
    async function workerViewDetail(id) {
      const modal = document.getElementById('workerDetailModal');
      const body = document.getElementById('workerDetailBody');
      body.innerHTML = '<div class="form-hint">加载中...</div>';
      modal.classList.add('open');
      try {
        const d = await fetchJSON('/admin/api/workers/'+id);
        const hw = d.hardware || {};
        const js = d.jobStats || {};
        const fmtMb = (mb) => (mb === null || mb === undefined) ? '-' : (mb >= 1024 ? (mb/1024).toFixed(1) + ' GB' : mb + ' MB');
        const fmtMhz = (mhz) => (mhz === null || mhz === undefined) ? '-' : (mhz >= 1000 ? (mhz/1000).toFixed(2) + ' GHz' : mhz + ' MHz');
        // 真实在线/离线判定：使用后端计算的 status（基于 sessionActive + 心跳超时）
        //   sessionActive=true 但心跳超时的 Worker 也应显示为离线，而非在线
        const isOnline = d.status === 'IDLE' || d.status === 'BUSY';
        const statusLabel = d.statusLabel || (d.sessionActive ? '在线' : '离线');
        const statusBadge = isOnline
          ? '<span class="badge online">' + escapeHtml(statusLabel) + '</span>'
          : '<span class="badge offline">' + escapeHtml(statusLabel) + '</span>';
        const heartbeatHint = d.heartbeatAgeSec === null ? '未收到心跳' : d.heartbeatAgeSec + ' 秒前心跳';
        const rows = [
          ['节点名称', escapeHtml(d.displayName || '-')],
          ['编号', '<code>' + escapeHtml(d.customCode || d.code) + '</code>'],
          ['状态', statusBadge + (d.offlineSince ? ' <span class="form-hint">下线于 ' + fmtDate(d.offlineSince) + '</span>' : '') + ' <span class="form-hint">' + heartbeatHint + '</span>'],
          ['机器指纹', '<code>' + escapeHtml(d.machineFingerprint || '-') + '</code>'],
          ['注册 IP', '<code>' + escapeHtml(d.registeredIp || '-') + '</code>'],
          ['PS 版本', escapeHtml(d.psVersion || '-') + ' (主版本 ' + (d.psMajorVersion || '-') + ')'],
          ['操作系统', escapeHtml(d.os || '-') + (d.osVersion ? ' / ' + escapeHtml(d.osVersion) : '')],
          ['设备主机名', escapeHtml(hw.hostname || '-')],
          ['CPU 型号', escapeHtml(hw.cpuModel || '-')],
          ['CPU 核心', hw.cpuCores !== null && hw.cpuCores !== undefined ? hw.cpuCores + ' 物理核 / ' + (hw.cpuLogicalCores ?? '-') + ' 逻辑核' : '-'],
          ['CPU 主频', fmtMhz(hw.cpuClockMhz)],
          ['显卡型号', escapeHtml(hw.gpuModel || '-')],
          ['显卡显存', fmtMb(hw.gpuVramMb)],
          ['物理内存', fmtMb(hw.totalMemoryMb) + (hw.availableMemoryMb !== null && hw.availableMemoryMb !== undefined ? ' (可用 ' + fmtMb(hw.availableMemoryMb) + ')' : '')],
          ['磁盘空间', hw.diskTotalMb !== null && hw.diskTotalMb !== undefined ? fmtMb(hw.diskTotalMb) + ' (剩余 ' + fmtMb(hw.diskFreeMb) + ')' : '-'],
          ['字体清单哈希', '<code>' + escapeHtml((d.fontInventoryHash || '').slice(0, 16) || '-') + '</code>'],
          ['令牌状态', d.accessTokenPresent ? '已颁发 (过期: ' + fmtDate(d.tokenExpiresAt) + ')' : '未颁发'],
          ['最后心跳', fmtDate(d.lastHeartbeatAt)],
          ['注册时间', fmtDate(d.registeredAt)],
          ['累计任务', js.total + ' 次 (成功 ' + js.succeeded + ' / 失败 ' + js.failed + ')'],
          ['当前任务', d.currentJobId ? '<code>' + escapeHtml(d.currentJobId) + '</code>' : '空闲'],
        ];
        let html = '<table class="detail-table" style="width:100%; border-collapse: collapse;"><tbody>';
        for (const [k, v] of rows) {
          html += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);"><td style="padding: 8px 12px; color: rgba(255,255,255,0.55); width: 130px; vertical-align: top;">' + k + '</td><td style="padding: 8px 12px; word-break: break-all;">' + v + '</td></tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<div class="form-hint" style="color: #f87171;">加载失败: ' + escapeHtml(e.message || '未知错误') + '</div>';
      }
    }
    function closeWorkerDetail() {
      document.getElementById('workerDetailModal').classList.remove('open');
    }
    let workerNameEditorId = null;
    function workerEditName(id) {
      const current = workersById.get(id)?.displayName || '';
      workerNameEditorId = id;
      document.getElementById('workerNameInput').value = current;
      document.getElementById('workerNameStatus').textContent = '';
      document.getElementById('workerNameModal').classList.add('open');
      document.getElementById('workerNameInput').focus();
    }
    function closeWorkerNameEditor() {
      document.getElementById('workerNameModal').classList.remove('open');
      workerNameEditorId = null;
    }
    async function saveWorkerNameEditor() {
      if (!workerNameEditorId) return;
      const name = document.getElementById('workerNameInput').value.trim();
      const status = document.getElementById('workerNameStatus');
      try {
        await fetchJSON('/admin/api/workers/'+workerNameEditorId+'/display-name', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ displayName: name || null }) });
        closeWorkerNameEditor();
        loadWorkers();
      } catch (e) { status.textContent = '保存失败: ' + e.message; }
    }
    let workerCodeEditorId = null;
    function workerEditCode(id) {
      const current = workersById.get(id)?.customCode || '';
      workerCodeEditorId = id;
      document.getElementById('workerCodeInput').value = current;
      document.getElementById('workerCodeStatus').textContent = '';
      document.getElementById('workerCodeModal').classList.add('open');
      document.getElementById('workerCodeInput').focus();
    }
    function closeWorkerCodeEditor() {
      document.getElementById('workerCodeModal').classList.remove('open');
      workerCodeEditorId = null;
    }
    async function saveWorkerCodeEditor() {
      if (!workerCodeEditorId) return;
      const raw = document.getElementById('workerCodeInput').value.trim();
      const status = document.getElementById('workerCodeStatus');
      try {
        await fetchJSON('/admin/api/workers/'+workerCodeEditorId+'/custom-code', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ customCode: raw || null }) });
        closeWorkerCodeEditor();
        loadWorkers();
      } catch (e) { status.textContent = '保存失败: ' + e.message; }
    }
    async function jobForceCancel(code) {
      if (!await showConfirm('确定强制取消任务 '+code+'？')) return;
      const r = await fetchJSON('/admin/api/jobs/'+code+'/force-cancel', { method: 'POST' });
      alert(r.updated ? '已强制取消' : '任务已是终态');
      loadJobs();
    }
    async function jobReleaseLease(code) {
      if (!await showConfirm('确定释放任务 '+code+' 的租约？任务将回到 QUEUED。')) return;
      try {
        const r = await fetchJSON('/admin/api/jobs/'+code+'/release-lease', { method: 'POST' });
        alert('租约已释放');
      } catch(e) { alert(e.message); }
      loadJobs();
    }
    async function jobRetry(code) {
      if (!await showConfirm('确定重试任务 '+code+'？')) return;
      try {
        const r = await fetchJSON('/admin/api/jobs/'+code+'/retry', { method: 'POST' });
        alert('已重新入队，attempt='+r.attempt);
      } catch(e) { alert(e.message); }
      loadJobs();
    }
    async function batchCancel() {
      if (!await showConfirm('确定批量取消所有进行中（QUEUED/LEASED/PROCESSING/CANCELLING）任务？')) return;
      const r = await fetchJSON('/admin/api/jobs/batch-cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      alert('已取消 '+r.cancelled+' 个任务');
      loadJobs();
    }
    async function batchDeleteJobs() {
      if (!await showConfirm('确定批量删除所有已完成（SUCCEEDED/FAILED/CANCELLED）任务日志？\\n进行中的任务不受影响。')) return;
      const r = await fetchJSON('/admin/api/jobs/batch-delete', { method: 'POST' });
      alert('已删除 '+r.deleted+' 条任务日志');
      loadJobs();
    }
    async function tplPublish(id) {
      if (!await showConfirm('确定发布该模板？发布后不可修改。')) return;
      try { await fetchJSON('/admin/api/templates/'+id+'/publish', { method: 'POST' }); } catch(e) { alert(e.message); }
      loadTemplates();
    }
    async function tplArchive(id) {
      if (!await showConfirm('确定归档该模板？归档后将不能用于新任务。')) return;
      await fetchJSON('/admin/api/templates/'+id+'/archive', { method: 'POST' });
      loadTemplates();
    }
    async function tplUnarchive(id) {
      if (!await showConfirm('确定取消归档？')) return;
      await fetchJSON('/admin/api/templates/'+id+'/unarchive', { method: 'POST' });
      loadTemplates();
    }
    async function tplDelete(id) {
      if (!await showConfirm('确定删除该模板？有关联任务时保留历史数据，无关联任务时同步清理存储文件。')) return;
      try {
        const result = await fetchJSON('/admin/api/templates/'+id+'/delete', { method: 'POST' });
        if (result.error) throw new Error(result.message || '删除模板失败');
        await loadTemplates();
        await loadTestRender();
      } catch(e) { alert(e.message); }
    }
    function openTemplateUpload() {
      document.getElementById('templateUploadName').value = '';
      document.getElementById('templateUploadFile').value = '';
      document.getElementById('templateUploadPsVersion').value = '25.0';
      document.getElementById('templateUploadStatus').textContent = '';
      document.getElementById('templateUploadModal').classList.add('open');
    }
    function closeTemplateUpload() {
      document.getElementById('templateUploadModal').classList.remove('open');
    }
    async function submitTemplateUpload() {
      const name = document.getElementById('templateUploadName').value.trim();
      const file = document.getElementById('templateUploadFile').files[0];
      const psMinVersion = document.getElementById('templateUploadPsVersion').value.trim();
      const status = document.getElementById('templateUploadStatus');
      const button = document.getElementById('templateUploadSave');
      if (!name || !file) { status.textContent = '请填写模板名称并选择 PSD 文件'; return; }
      if (!file.name.toLowerCase().endsWith('.psd')) { status.textContent = '仅支持 .psd 文件'; return; }
      button.disabled = true;
      status.textContent = '上传并解析 PSD 中，请勿关闭页面...';
      try {
        const response = await fetch('/admin/api/templates/upload?fileName=' + encodeURIComponent(file.name) + '&name=' + encodeURIComponent(name) + '&psMinVersion=' + encodeURIComponent(psMinVersion), { method: 'POST', headers: { 'Content-Type': 'image/vnd.adobe.photoshop' }, body: file });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || '模板上传失败');
        status.textContent = '解析完成，模板已创建';
        await loadTemplates();
        closeTemplateUpload();
      } catch (e) { status.textContent = '上传失败: ' + e.message; }
      finally { button.disabled = false; }
    }
    async function fontToggle(id, publish) {
      // M9：后端权威校验许可证；前端仅处理错误提示
      try {
        const r = await fetch('/admin/api/fonts/'+id+'/'+(publish ? 'publish' : 'unpublish'), { method: 'POST' });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.message || 'HTTP ' + r.status);
        }
        loadFonts();
      } catch (e) { alert(e.message); }
    }
    async function fontEditLicense(id, current) {
      licenseEditorFontId = id;
      document.getElementById('licenseNoteInput').value = current || '';
      document.getElementById('licenseEditorStatus').textContent = '';
      document.getElementById('licenseModal').classList.add('open');
      document.getElementById('licenseNoteInput').focus();
    }
    async function fontDelete(id, familyName, postscriptName) {
      const label = (familyName || '') + ' (' + (postscriptName || '') + ')';
      if (!await showConfirm('确定删除字体 ' + label + '？\\n此操作不可恢复：将同步卸载系统字体、清理对象存储文件、删除数据库记录。')) return;
      if (!await showConfirm('再次确认：彻底删除字体 ' + label + '？\\n若被图层绑定引用，删除将被拒绝。')) return;
      try {
        const r = await fetchJSON('/admin/api/fonts/'+id, { method: 'DELETE' });
        let tip = '已删除';
        if (r.systemUninstalled) tip += '；系统字体已卸载';
        else tip += '；系统字体未卸载（可能未安装或权限不足）';
        if (r.storagePurged) tip += '；存储文件已清理';
        else tip += '；存储文件未清理';
        alert(tip);
        loadFonts();
      } catch (e) { alert('删除失败: ' + e.message); }
    }

    // ===== 字体上传 =====
    function openFontUpload() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ttf,.otf,.ttc';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        // 询问许可证备注（可选）
        const licenseNote = prompt('请输入字体许可证备注（可选，留空跳过）：', '') || '';
        try {
          const buffer = await file.arrayBuffer();
          const url = '/admin/api/fonts/upload?fileName=' + encodeURIComponent(file.name)
            + (licenseNote.trim() ? '&licenseNote=' + encodeURIComponent(licenseNote.trim()) : '');
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'font/otf' },
            body: new Uint8Array(buffer),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
          const installTip = data.installed
            ? '，已安装到系统'
            : '（安装失败：' + (data.installMessage || '未知原因') + '，Worker 同步时会重试）';
          alert('字体上传成功：' + data.familyName + ' (' + data.postscriptName + ')' + installTip);
          loadFonts();
        } catch (e) {
          alert('字体上传失败: ' + e.message);
        }
      };
      input.click();
    }

    let licenseEditorFontId = null;

    function closeLicenseEditor() {
      document.getElementById('licenseModal').classList.remove('open');
      licenseEditorFontId = null;
    }

    async function saveLicenseEditor() {
      if (!licenseEditorFontId) return;
      const button = document.getElementById('licenseEditorSave');
      const status = document.getElementById('licenseEditorStatus');
      const note = document.getElementById('licenseNoteInput').value.trim();
      button.disabled = true;
      status.textContent = '保存中...';
      try {
        await fetchJSON('/admin/api/fonts/'+licenseEditorFontId+'/license-note', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseNote: note || null }),
        });
        await loadFonts();
        closeLicenseEditor();
      } catch (e) {
        status.textContent = '保存失败: ' + e.message;
      } finally {
        button.disabled = false;
      }
    }

    async function loadAlerts() {
      const { alerts } = await fetchJSON('/admin/api/alerts?limit=100');
      if (!alerts.length) { document.getElementById('alerts').innerHTML = '<tr><td class="empty">暂无告警</td></tr>'; return; }
      document.getElementById('alerts').innerHTML = \`
        <thead><tr><th>级别</th><th>类型</th><th>标题</th><th>消息</th><th>状态</th><th>触发时间</th><th>操作</th></tr></thead>
        <tbody>
        \${alerts.map(a => \`<tr class="alert-row \${a.severity} \${a.status}">
          <td><span class="badge sev-\${a.severity}">\${alertSeverityLabel(a.severity)}</span></td>
          <td><code title="\${escapeHtml(a.type)}">\${escapeHtml(alertTypeLabel(a.type))}</code></td>
          <td>\${escapeHtml(a.title)}</td>
          <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${escapeHtml(a.message)}">\${escapeHtml(a.message)}</td>
          <td><span class="badge \${a.status === 'ACTIVE' ? 'FAILED' : a.status === 'ACKED' ? 'QUEUED' : 'SUCCEEDED'}">\${alertStatusLabel(a.status)}</span></td>
          <td>\${fmtDate(a.triggeredAt)}</td>
          <td>\${a.status === 'ACTIVE' ? \`<button class="btn-ack" onclick="ackAlert('\${a.id}')">确认</button>\` : '-'}</td>
        </tr>\`).join('')}
        </tbody>\`;
    }

    async function ackAlert(id) {
      try {
        await fetch('/admin/api/alerts/' + id + '/ack', { method: 'POST' });
        await loadAlerts();
      } catch (e) { alert('确认失败: ' + e.message); }
    }
    async function batchClearAlerts() {
      if (!await showConfirm('确定清除所有告警日志？此操作不可恢复。')) return;
      try {
        const r = await fetchJSON('/admin/api/alerts/batch-clear', { method: 'POST' });
        alert('已清除 '+r.deleted+' 条告警日志');
        await loadAlerts();
      } catch (e) { alert('清除失败: ' + e.message); }
    }

    // ===== Webhook 投递日志（M6） =====
    async function loadWebhookLogs() {
      const r = await fetchJSON('/admin/api/webhook-logs?pageSize=50');
      const logs = r && r.items;
      if (!logs || !logs.length) { document.getElementById('webhookLogs').innerHTML = '<tr><td class="empty">暂无 Webhook 投递记录</td></tr>'; return; }
      document.getElementById('webhookLogs').innerHTML = \`
        <thead><tr><th>事件</th><th>状态</th><th>Job</th><th>尝试</th><th>响应码</th><th>错误</th><th>下次重试</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
        \${logs.map(l => {
          let ops = '';
          if (l.status === 'FAILED') {
            ops += '<button class="btn-act" onclick="webhookRetry(\\'' + l.id + '\\')">重试</button>';
          }
          return \`<tr>
            <td><code>\${escapeHtml(l.event)}</code></td>
            <td><span class="badge \${l.status === 'DELIVERED' ? 'SUCCEEDED' : (l.status === 'FAILED' ? 'FAILED' : 'QUEUED')}">\${l.status}</span></td>
            <td><code title="\${escapeHtml(l.jobId)}">\${escapeHtml(l.jobId.slice(0,8))}…</code></td>
            <td>\${l.attempt}/\${l.maxAttempts}</td>
            <td>\${l.responseCode || '-'}</td>
            <td>\${l.lastError ? '<span title="'+escapeHtml(l.lastError)+'">'+escapeHtml(l.lastError.slice(0,40))+'</span>' : '-'}</td>
            <td>\${fmtDate(l.nextAttemptAt)}</td>
            <td>\${fmtDate(l.createdAt)}</td>
            <td class="ops">\${ops}</td>
          </tr>\`;
        }).join('')}
        </tbody>\`;
    }

    async function webhookRetry(id) {
      if (!await showConfirm('确定要立即重试此 Webhook 投递吗？')) return;
      try {
        const r = await fetch('/admin/api/webhook-logs/' + id + '/retry', { method: 'POST' });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.message || 'HTTP ' + r.status);
        }
        await loadWebhookLogs();
      } catch (e) { alert('重试失败: ' + e.message); }
    }

    // ===== M5：图层绑定配置编辑器 =====
    let bindingState = {
      templateId: null,
      templateName: '',
      versionInfo: null,
      layerTree: [],
      flatLayers: [],
      bindings: new Map(),
      selectedLayerPath: null,
      // 已发布字体列表（供 text 绑定选择 defaultFontVersionId）
      fonts: [],
    };

    function flattenLayers(nodes, out) {
      for (const n of nodes) {
        out.push(n);
        if (n.children && n.children.length) flattenLayers(n.children, out);
      }
      return out;
    }

    async function openBindingEditor(templateId, templateName) {
      try {
        const detail = await fetchJSON('/admin/api/templates/' + templateId);
        if (!detail || !detail.latestVersion) {
          alert('模板无版本数据，无法编辑绑定');
          return;
        }
        if (detail.latestVersion.published) {
          alert('已发布版本不可修改绑定');
          return;
        }
        const v = detail.latestVersion;
        if (!v.layerTree || !v.layerTree.length) {
          alert('图层树为空，无法编辑绑定');
          return;
        }
        bindingState.templateId = templateId;
        bindingState.templateName = templateName || detail.name;
        bindingState.versionInfo = v;
        bindingState.layerTree = v.layerTree;
        bindingState.flatLayers = flattenLayers(v.layerTree, []);
        bindingState.bindings = new Map();
        bindingState.selectedLayerPath = null;
        // 载入已存在的绑定
        const existing = (v.layerSchema && v.layerSchema.bindings) || [];
        for (const b of existing) {
          bindingState.bindings.set(b.layerPath, { ...b });
        }
        // 载入已发布字体列表（供 text 绑定选择字体）
        try {
          const { fonts } = await fetchJSON('/admin/api/fonts');
          bindingState.fonts = (fonts || []).filter(f => f.published);
        } catch (e) {
          bindingState.fonts = [];
        }
        document.getElementById('bindingModalTitle').textContent = '图层绑定配置 - ' + bindingState.templateName;
        document.getElementById('bindingModalMeta').textContent =
          '版本 v' + v.version + ' · 画布 ' + v.canvas.width + '×' + v.canvas.height + ' · PS ' + v.psMinVersion + '+';
        renderLayerTree();
        renderBindingEditor();
        updateBindingSummary();
        document.getElementById('bindingModal').classList.add('open');
      } catch (e) {
        alert('加载模板详情失败: ' + e.message);
      }
    }

    function closeBindingEditor() {
      document.getElementById('bindingModal').classList.remove('open');
    }

    function renderLayerTree() {
      const container = document.getElementById('bindingLayerTree');
      const html = renderLayerNodes(bindingState.layerTree, 0);
      container.innerHTML = html || '<div class="empty-layer">无图层</div>';
    }

    function renderLayerNodes(nodes, depth) {
      if (!nodes || !nodes.length) return '';
      return nodes.map(n => {
        const isBound = bindingState.bindings.has(n.layerPath);
        const isSelected = bindingState.selectedLayerPath === n.layerPath;
        const childHtml = (n.children && n.children.length)
          ? '<div class="layer-children">' + renderLayerNodes(n.children, depth + 1) + '</div>'
          : '';
        return '<div>' +
          '<div class="layer-node ' + (isSelected ? 'selected' : '') + '" data-layer-path="' + escapeHtml(n.layerPath) + '" onclick="selectLayer(this.dataset.layerPath)">' +
            '<span class="name">' + escapeHtml(n.name) + '</span>' +
            '<span class="type">' + n.type + '</span>' +
            (isBound ? '<span class="bound">●已绑定</span>' : '') +
          '</div>' +
          childHtml +
        '</div>';
      }).join('');
    }

    function selectLayer(layerPath) {
      bindingState.selectedLayerPath = bindingState.selectedLayerPath === layerPath ? null : layerPath;
      renderLayerTree();
      renderBindingEditor();
    }

    function getCurrentLayer() {
      return bindingState.flatLayers.find(l => l.layerPath === bindingState.selectedLayerPath);
    }

    function renderBindingEditor() {
      const container = document.getElementById('bindingEditor');
      const layer = getCurrentLayer();
      if (!layer) {
        container.innerHTML = '<div class="empty-layer">请从左侧选择一个图层</div>';
        return;
      }
      const b = bindingState.bindings.get(layer.layerPath);
      const isBound = !!b;
      // smartObject/text/pixel 支持绑定替换；其他类型仅展示不可绑定
      const isSmartObject = layer.type === 'smartObject';
      const isText = layer.type === 'text';
      const isPixel = layer.type === 'pixel';
      const canBind = isSmartObject || isText || isPixel;
      const acceptedFormatsValue = b && b.acceptedFormats ? b.acceptedFormats.join(',') : 'jpg,png,jpeg';

      container.innerHTML = ''
        + '<h2 style="margin-top:0">图层：' + escapeHtml(layer.name) + '</h2>'
        + '<div style="font-size:11px;color:#8b95a7;margin-bottom:16px">'
        +   '类型: <code>' + layer.type + '</code> · '
        +   'layerId: <code>' + layer.layerId + '</code> · '
        +   'layerPath: <code>' + escapeHtml(layer.layerPath) + '</code>'
        + (layer.bounds ? ' · 尺寸: ' + (layer.bounds.right - layer.bounds.left) + '×' + (layer.bounds.bottom - layer.bounds.top) : '')
        + (layer.smartObjectSize ? ' · 内部尺寸: ' + layer.smartObjectSize.width + '×' + layer.smartObjectSize.height : '')
        + '</div>'
        + (canBind ? ''
          + '<div class="form-row">'
          +   '<div class="checkbox-row">'
          +   '<input type="checkbox" id="bindEnabled" ' + (isBound ? 'checked' : '') + ' onchange="toggleBinding(this.checked)"/>'
          +   '<label for="bindEnabled" style="margin:0">将此图层标记为可替换绑定</label>'
          +   '</div>'
          + '<div class="form-hint">勾选后，调用方可通过 bindingId 替换该图层内容</div>'
        + '</div>' : '<div class="form-hint" style="color:#e57373">该图层类型不支持绑定替换（仅智能对象、文字和像素图层可绑定）</div>')
        + (isBound && canBind ? ''
          + '<div class="form-row">'
          +   '<label>bindingId（业务侧标识，唯一）</label>'
          +   '<input type="text" id="bindId" value="' + escapeHtml(b.bindingId) + '" oninput="updateBindingField(\\'bindingId\\', this.value)"/>'
          +   '<div class="form-hint">建议使用有业务含义的标识，如 main_image / title_text</div>'
          + '</div>'
          + '<div class="form-row">'
          +   '<label>类型</label>'
          +   '<select onchange="updateBindingField(\\'type\\', this.value)">'
          +     ['smartObject','text','pixel'].map(t => '<option value="' + t + '"' + (b.type === t ? ' selected' : '') + '">' + t + '</option>').join('')
          +   '</select>'
          + '</div>'
          + '<div class="form-row">'
          +   '<div class="checkbox-row">'
          +   '<input type="checkbox" id="bindRequired" ' + (b.required ? 'checked' : '') + ' onchange="updateBindingField(\\'required\\', this.checked)"/>'
          +   '<label for="bindRequired" style="margin:0">必填（提交任务时必须提供）</label>'
          +   '</div>'
          + '</div>'
          + '<div class="form-row">'
          +   '<label>显示标签（可选，便于调用方理解）</label>'
          +   '<input type="text" id="bindLabel" value="' + escapeHtml(b.label || '') + '" oninput="updateBindingField(\\'label\\', this.value)"/>'
          + '</div>'
          + (isSmartObject || isText || isPixel ? ''
            + '<div class="form-row">'
            +   '<label>接受的格式（逗号分隔）</label>'
            +   '<input type="text" id="bindFormats" value="' + escapeHtml(acceptedFormatsValue) + '" oninput="updateBindingField(\\'acceptedFormats\\', this.value.split(\\',\\').map(s=>s.trim()).filter(Boolean))"/>'
            +   '<div class="form-hint">如 jpg,png,jpeg</div>'
            + '</div>' : '')
          + (isSmartObject || isPixel ? ''
            + '<div class="form-row">'
            +   '<label>填充方式</label>'
            +   '<select onchange="updateBindingField(\\'fit\\', this.value)">'
            +     '<option value="stretch"' + (b.fit === 'stretch' || !b.fit ? ' selected' : '') + '>stretch（拉伸，默认）</option>'
            +     '<option value="cover"' + (b.fit === 'cover' ? ' selected' : '') + '>cover（铺满，可能裁剪）</option>'
            +     '<option value="contain"' + (b.fit === 'contain' ? ' selected' : '') + '>contain（完整包含，可能留白）</option>'
            +   '</select>'
            +   '<div class="form-hint">默认 stretch：将图片拉伸到目标尺寸，完全显示</div>'
            + '</div>' : '')
          + (isText ? ''
            + '<div class="form-row">'
            +   '<label>最大字符数（可选）</label>'
            +   '<input type="number" min="1" value="' + (b.maxLength || '') + '" oninput="updateBindingField(\\'maxLength\\', this.value ? parseInt(this.value,10) : undefined)"/>'
            + '</div>'
            + '<div class="form-row">'
            +   '<label>替换字体（可选）</label>'
            +   '<select onchange="updateBindingField(\\'defaultFontVersionId\\', this.value || undefined)">'
            +     '<option value=""' + (!b.defaultFontVersionId ? ' selected' : '') + '>不指定（保留原图层字体）</option>'
            +     (bindingState.fonts || []).map(f => '<option value="' + f.fontId + '"' + (b.defaultFontVersionId === f.fontId ? ' selected' : '') + '>' + escapeHtml(f.familyName + ' - ' + f.style) + ' (' + escapeHtml(f.postscriptName) + ')</option>').join('')
            +   '</select>'
            +   '<div class="form-hint">选择后渲染时将应用此字体；需先在"字体管理"上传并启用字体</div>'
            + '</div>' : '')
          + (layer.defaultText ? '<div class="form-hint">图层默认文本: <code>' + escapeHtml(layer.defaultText) + '</code></div>' : '')
          : '<div class="empty-layer">该图层未启用绑定</div>');
    }

    function toggleBinding(enabled) {
      const layer = getCurrentLayer();
      if (!layer) return;
      // 防御：仅 smartObject/text/pixel 允许启用绑定
      if (enabled && layer.type !== 'smartObject' && layer.type !== 'text' && layer.type !== 'pixel') {
        alert('该图层类型不支持绑定替换（仅智能对象、文字和像素图层可绑定）');
        document.getElementById('bindEnabled').checked = false;
        return;
      }
      if (enabled) {
        // 启用：用图层名作为默认 bindingId（去空格、转下划线）
        const defaultId = String(layer.name || '').trim().replace(/\\s+/g, '_').replace(/[^a-zA-Z0-9_\\u4e00-\\u9fa5-]/g, '') || 'layer_' + layer.layerId;
        const isImageType = layer.type === 'smartObject' || layer.type === 'pixel';
        bindingState.bindings.set(layer.layerPath, {
          bindingId: defaultId,
          layerId: layer.layerId,
          layerPath: layer.layerPath,
          type: layer.type,
          required: true,
          label: layer.name,
          acceptedFormats: ['jpg', 'png', 'jpeg'],
          fit: isImageType ? 'stretch' : undefined,
          maxLength: layer.type === 'text' ? 100 : undefined,
        });
      } else {
        bindingState.bindings.delete(layer.layerPath);
      }
      renderLayerTree();
      renderBindingEditor();
      updateBindingSummary();
    }

    function updateBindingField(field, value) {
      const layer = getCurrentLayer();
      if (!layer) return;
      const b = bindingState.bindings.get(layer.layerPath);
      if (!b) return;
      b[field] = value;
      // bindingId 改变时同步左侧树显示
      if (field === 'bindingId') renderLayerTree();
      updateBindingSummary();
    }

    function updateBindingSummary() {
      const total = bindingState.flatLayers.length;
      const bound = bindingState.bindings.size;
      document.getElementById('bindingSummary').textContent =
        '已配置 ' + bound + ' / ' + total + ' 个图层绑定';
    }

    async function saveBindings() {
      const bindings = Array.from(bindingState.bindings.values());
      // 简单校验：bindingId 唯一 + 非空
      const ids = new Set();
      for (const b of bindings) {
        if (!b.bindingId || !b.bindingId.trim()) {
          alert('图层 ' + b.layerId + ' 的 bindingId 不能为空');
          return;
        }
        if (ids.has(b.bindingId)) {
          alert('bindingId 重复: ' + b.bindingId);
          return;
        }
        ids.add(b.bindingId);
      }
      if (!await showConfirm('确定保存 ' + bindings.length + ' 项图层绑定配置？')) return;
      try {
        const r = await fetch('/admin/api/templates/' + bindingState.templateId + '/layer-bindings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bindings }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
        alert('保存成功（' + (data.bindingCount || bindings.length) + ' 项绑定）');
        closeBindingEditor();
        loadTemplates();
      } catch (e) {
        alert('保存失败: ' + e.message);
      }
    }

    // ===== Worker 注册配对码管理 =====
    let bootstrapTokensList = [];

    // 状态 → badge 样式与中文文案
    function bootstrapTokenStatusBadge(status) {
      if (status === 'unused') return '<span class="badge SUCCEEDED">未使用</span>';
      if (status === 'used') return '<span class="badge offline">已使用</span>';
      if (status === 'expired') return '<span class="badge offline">已过期</span>';
      if (status === 'revoked') return '<span class="badge FAILED">已作废</span>';
      return '<span class="badge offline">' + escapeHtml(status || '-') + '</span>';
    }

    async function loadBootstrapTokens() {
      try {
        const r = await fetchJSON('/admin/api/bootstrap-tokens');
        const tokens = (r && r.tokens) || [];
        bootstrapTokensList = tokens;
        if (!tokens.length) {
          document.getElementById('bootstrapTokens').innerHTML = '<tr><td class="empty">暂无配对码</td></tr>';
          return;
        }
        document.getElementById('bootstrapTokens').innerHTML = \`
          <thead><tr><th>配对码</th><th>状态</th><th>备注</th><th>创建人</th><th>创建时间</th><th>过期时间</th><th>使用时间</th><th>操作</th></tr></thead>
          <tbody>
          \${tokens.map(t => \`<tr>
            <td><code>\${escapeHtml(t.pairingCode)}</code></td>
            <td>\${bootstrapTokenStatusBadge(t.status)}</td>
            <td>\${escapeHtml(t.note || '-')}</td>
            <td>\${escapeHtml(t.createdBy || '-')}</td>
            <td>\${fmtDate(t.createdAt)}</td>
            <td>\${fmtDate(t.expiresAt)}</td>
            <td>\${fmtDate(t.usedAt)}</td>
            <td class="ops">\${t.status === 'unused' ? \`<button class="btn-act danger" onclick="bootstrapTokenRevoke('\${t.id}')">作废</button>\` : (t.status === 'revoked' || t.status === 'expired') ? \`<button class="btn-act danger" onclick="bootstrapTokenDelete('\${t.id}')">删除</button>\` : '-'}</td>
          </tr>\`).join('')}
          </tbody>\`;
      } catch (e) {
        document.getElementById('bootstrapTokens').innerHTML = '<tr><td class="empty">加载失败: ' + escapeHtml((e && e.message) || '') + '</td></tr>';
      }
    }

    function bootstrapTokenCreate() {
      document.getElementById('bootstrapTokenNote').value = '';
      document.getElementById('bootstrapTokenCreateStatus').textContent = '';
      document.getElementById('bootstrapTokenCreateSave').disabled = false;
      document.getElementById('bootstrapTokenCreateModal').classList.add('open');
    }

    function closeBootstrapTokenCreate() {
      document.getElementById('bootstrapTokenCreateModal').classList.remove('open');
    }

    async function bootstrapTokenSubmit() {
      const status = document.getElementById('bootstrapTokenCreateStatus');
      const button = document.getElementById('bootstrapTokenCreateSave');
      const note = document.getElementById('bootstrapTokenNote').value.trim();
      button.disabled = true;
      status.textContent = '生成中...';
      try {
        const r = await fetchJSON('/admin/api/bootstrap-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(note ? { note } : {}),
        });
        closeBootstrapTokenCreate();
        showBootstrapTokenResult(r && r.pairingCode);
        loadBootstrapTokens();
      } catch (e) {
        status.textContent = '生成失败: ' + ((e && e.message) ? e.message : e);
      } finally {
        button.disabled = false;
      }
    }

    // 展示配对码结果弹框（大字号醒目展示 + 复制按钮）
    function showBootstrapTokenResult(pairingCode) {
      document.getElementById('bootstrapTokenResultCode').textContent = pairingCode || '';
      document.getElementById('bootstrapTokenResultCodeText').textContent = pairingCode || '';
      const btn = document.getElementById('bootstrapTokenResultCopyBtn');
      btn.classList.remove('copied');
      document.getElementById('bootstrapTokenResultCopyText').textContent = '复制';
      document.getElementById('bootstrapTokenResultModal').classList.add('open');
    }

    function closeBootstrapTokenResult() {
      document.getElementById('bootstrapTokenResultModal').classList.remove('open');
    }

    // 复制配对码到剪贴板
    async function copyBootstrapTokenResult() {
      const text = document.getElementById('bootstrapTokenResultCodeText').textContent;
      const btn = document.getElementById('bootstrapTokenResultCopyBtn');
      const label = document.getElementById('bootstrapTokenResultCopyText');
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        // 降级：选中文本并尝试 execCommand
        try {
          const range = document.createRange();
          range.selectNode(document.getElementById('bootstrapTokenResultCodeText'));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          ok = document.execCommand('copy');
          sel.removeAllRanges();
        } catch (e2) { ok = false; }
      }
      if (ok) {
        btn.classList.add('copied');
        label.textContent = '已复制';
      } else {
        label.textContent = '复制失败，请手动选择';
      }
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = '复制';
      }, 2000);
    }

    async function bootstrapTokenRevoke(id) {
      if (!await showConfirm('确定作废该配对码？作废后该配对码将无法用于 Worker 注册。')) return;
      try {
        await fetchJSON('/admin/api/bootstrap-tokens/' + id, { method: 'DELETE' });
        loadBootstrapTokens();
      } catch (e) { alert('作废失败: ' + (e.message || '未知错误')); }
    }
    async function bootstrapTokenDelete(id) {
      if (!await showConfirm('确定删除该配对码记录？此操作不可恢复。')) return;
      try {
        await fetchJSON('/admin/api/bootstrap-tokens/' + id + '/delete', { method: 'POST' });
        loadBootstrapTokens();
      } catch (e) { alert('删除失败: ' + (e.message || '未知错误')); }
    }

    async function loadAll() {
      await Promise.all([loadStats(), loadAlerts(), loadWorkers(), loadStorageSettings(), loadJobs(), loadTemplates(), loadFonts(), loadApiKeys(), loadWebhookLogs(), loadTestRender(), loadBootstrapTokens()]);
    }
    loadMe();
    loadAll();
    setInterval(loadAll, 5000);
  </script>
</body>
</html>`;
