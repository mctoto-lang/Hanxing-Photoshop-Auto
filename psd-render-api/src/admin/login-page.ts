/**
 * Admin 登录页 HTML（第三期 M3）
 */
export const loginPageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2Ij48cGF0aCBkPSJNNjQgMzg4LjI1NmMwLTExMy41MDQgMC0xNzAuMjQgMjIuMDgtMjEzLjZBMjAyLjY1NiAyMDIuNjU2IDAgMCAxIDE3NC42NTYgODYuMDhDMjE4LjAxNiA2NCAyNzQuNzUyIDY0IDM4OC4yNTYgNjRoMjQ3LjQ4OGMxMTMuNTA0IDAgMTcwLjI0IDAgMjEzLjYgMjIuMDhhMjAyLjY1NiAyMDIuNjU2IDAgMCAxIDg4LjU3NiA4OC41NzZjMjIuMDggNDMuMzYgMjIuMDggMTAwLjA5NiAyMi4wOCAyMTMuNnYyNDcuNDg4YzAgMTEzLjUwNCAwIDE3MC4yNC0yMi4wOCAyMTMuNmEyMDIuNjU2IDIwMi42NTYgMCAwIDEtODguNTc2IDg4LjU3NmMtNDMuMzYgMjIuMDgtMTAwLjA5NiAyMi4wOC0yMTMuNiAyMi4wOGgtMjQ3LjQ4OGMtMTEzLjUwNCAwLTE3MC4yNCAwLTIxMy42LTIyLjA4YTIwMi42NTYgMjAyLjY1NiAwIDAgMS04OC41NzYtODguNTc2QzY0IDgwNS45ODQgNjQgNzQ5LjI0OCA2NCA2MzUuNzQ0di0yNDcuNDg4eiIgZmlsbD0iIzAwMUUzNiIvPjxwYXRoIGQ9Ik0yNTYgNzIwLjUxMlYzMjYuNDk2YzAtMi42NTYgMS4xMi00LjE5MiAzLjc0NC00LjE5MiAzOC41NiAwIDc3LjEyLTIuMzA0IDExNS43MTItMi4zMDQgNjIuNjI0IDAgMTMwLjQzMiAyMS40NCAxNTQuMjA4IDg2LjkxMiA1LjYgMTYuMDk2IDguNTc2IDMyLjU0NCA4LjU3NiA0OS43OTIgMCAzMi45MjgtNy40NTYgNjAuMDk2LTIyLjQgODEuNTM2LTQxLjcyOCA1OS45MDQtMTE0LjAxNiA1OC45NzYtMTc4LjgxNiA1OC45NzZ2MTIyLjkxMmMwLjQ4IDMuNjQ4LTIuNTkyIDUuMzc2LTUuNiA1LjM3NkgyNjAuNDhjLTIuOTc2IDAtNC40OC0xLjUzNi00LjQ4LTQuOTkyeiBtODEuMzc2LTMyNC4zMnYxMjguNjRjMjUuNjk2IDEuOTIgNTIuNjA4IDIuMTEyIDc3LjI4LTYuMDggMjcuMjY0LTcuODcyIDQyLjIwOC0zMS40ODggNDIuMjA4LTU5Ljc0NCAwLjczNi0yNC4wOTYtMTIuMzg0LTQ3LjIzMi0zNC43Mi01NS45MDQtMjQuNDE2LTEwLjE0NC01OC40MzItMTAuNzUyLTg0Ljc2OC02LjkxMnpNNzcxLjEwNCA0OTkuNDI0YTEzOC4xMTIgMTM4LjExMiAwIDAgMC0zNS43NzYtMTIuOTI4Yy0xNi0zLjc3Ni03OS4wNC0xNi45Ni03OS4wNCAxNiAwLjU0NCAxOC40MzIgMjkuNzYgMjcuNDI0IDQyLjY4OCAzMi43MDQgNDUuMzEyIDE1LjU1MiA5Ni41NzYgNDMuMzYgOTUuNTUyIDk5LjIzMiAxLjM3NiA2OS42LTY2LjAxNiA5Ny40MDgtMTIzLjg0IDk3LjQwOC0zMC4wOCAwLjMyLTYxLjQwOC00LjM1Mi04OC45Ni0xNy4yOGE4LjE2IDguMTYgMCAwIDEtNC4xNi03LjM2di02Ni41OTJjLTAuMzItMi42NTYgMi41Ni00Ljk5MiA0LjgtMy4wNzIgMjYuOTc2IDE2LjMyIDU4Ljk0NCAyNC4yMjQgOTAuMTQ0IDI0LjY0IDEzLjc2IDAgNDEuMDg4LTEuMzEyIDQwLjg5Ni0yMS41NjggMC0xOS40MjQtMzIuNjcyLTI4LjM1Mi00NS42OTYtMzMuMjhhMjE4Ljg4IDIxOC44OCAwIDAgMS01My4xODQtMjcuNzQ0IDg2LjUyOCA4Ni41MjggMCAwIDEtMzYuOTkyLTcxLjUyYy0wLjEyOC02NS41MDQgNjEuOTUyLTk0LjkxMiAxMTcuODI0LTk0Ljk0NCAyNi4xMTItMC4yMjQgNTQuMTc2IDEuNzI4IDc4LjQ5NiAxMi4zNTIgMy41MiAxLjAyNCA0LjIyNCA0LjcwNCA0LjIyNCA4djYyLjI3MmMwLjIyNCAzLjg0LTQuMDk2IDUuMTg0LTYuOTc2IDMuNjh6IiBmaWxsPSIjMzFBOEZGIi8+PC9zdmc+" />
  <title>PSD 渲染服务 - 登录</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #0f1419; color: #e6e6e6;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1f2e; padding: 32px; border-radius: 8px;
      border: 1px solid #2a3142; width: 360px;
    }
    h1 { font-size: 18px; color: #4fc3f7; margin-bottom: 24px; text-align: center; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 12px; color: #8b95a7; margin-bottom: 6px; }
    input {
      width: 100%; padding: 10px 12px; font-size: 14px;
      background: #0f1419; color: #e6e6e6;
      border: 1px solid #2a3142; border-radius: 4px; outline: none;
    }
    input:focus { border-color: #4fc3f7; }
    button {
      width: 100%; padding: 10px; font-size: 14px;
      background: #1976d2; color: #fff; border: none;
      border-radius: 4px; cursor: pointer; margin-top: 8px;
    }
    button:hover { background: #1565c0; }
    button:disabled { background: #2a3142; cursor: not-allowed; }
    .error {
      background: #3f1e1e; color: #e57373; padding: 8px 12px;
      border-radius: 4px; font-size: 13px; margin-bottom: 16px;
      display: none;
    }
    .hint { font-size: 11px; color: #555; text-align: center; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>PSD 渲染服务控制台</h1>
    <div class="error" id="err"></div>
    <form id="form" onsubmit="return doLogin(event)">
      <div class="field">
        <label>用户名</label>
        <input id="username" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label>密码</label>
        <input id="password" type="password" autocomplete="current-password" required />
      </div>
      <button type="submit" id="btn">登录</button>
    </form>
    <div class="hint">PSD Render · Admin Console</div>
  </div>
  <script>
    async function doLogin(e) {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      btn.disabled = true; btn.textContent = '登录中...';
      err.style.display = 'none';
      try {
        const r = await fetch('/admin/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
          err.textContent = (data && (data.message || data.error)) || '登录失败 (HTTP ' + r.status + ')';
          err.style.display = 'block';
          btn.disabled = false; btn.textContent = '登录';
          return false;
        }
        // 登录成功，跳转到首页
        window.location.href = '/admin';
        return false;
      } catch (ex) {
        // 网关返回 HTML 错误页等非 JSON 内容时，直接显示 ex.message 会得到
        // "Unexpected token '<'..." 之类技术报错，对使用者无意义
        err.textContent = '服务暂不可用，请稍后重试（' + (ex.message || '网络错误') + '）';
        err.style.display = 'block';
        btn.disabled = false; btn.textContent = '登录';
        return false;
      }
    }
  </script>
</body>
</html>`;
