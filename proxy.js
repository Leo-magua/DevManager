/**
 * DevManager 反向代理 (Node.js)
 * 80 端口统一入口，PersonalWork 为主项目
 *
 * ─────────────────────────────────────────────────────────────────────
 *  ⚠️  PRIMARY REVERSE PROXY: proxy.js (this file)
 * ─────────────────────────────────────────────────────────────────────
 *
 * DevManager ships with TWO reverse-proxy implementations that both listen
 * on port 80 and therefore CANNOT run at the same time:
 *
 *   1. proxy.js (this file, default)        — pure Node.js, zero deps
 *   2. src/services/nginx-manager.js        — generates Homebrew nginx
 *                                              config and `sudo nginx -s
 *                                              reload`s it
 *
 * The default deployment (start-all.sh) uses proxy.js. The NginxManager is
 * an opt-in alternative kept around for setups that need nginx-only
 * features (HTTP/2, advanced caching, etc.). To switch engines:
 *
 *   - Set DEVMANAGER_PROXY_ENGINE=nginx and stop proxy.js, OR
 *   - Set DEVMANAGER_DISABLE_PROXY_JS=1 to make this script exit cleanly
 *     when the alternate engine owns the port.
 *
 * If port 80 is already in use we now log a warning and exit with code 0
 * (instead of crashing) when DEVMANAGER_DISABLE_PROXY_JS=1 — this lets
 * supervisors keep the unit "running" without restart loops.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

// Allow this proxy to be disabled entirely (when nginx engine is primary).
const DISABLE_PROXY_JS = /^(1|true|yes)$/i.test(process.env.DEVMANAGER_DISABLE_PROXY_JS || '');
if (DISABLE_PROXY_JS) {
  console.log('[Proxy] DEVMANAGER_DISABLE_PROXY_JS=1 — proxy.js disabled, exiting cleanly.');
  console.log('[Proxy] Reverse-proxy duties are expected to be handled by NginxManager.');
  process.exit(0);
}

const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
});

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PERSONALWORK_PORT = parseInt(process.env.PERSONALWORK_PORT || '3991', 10);
const DEVMANAGER_PORT = parseInt(process.env.DEVMANAGER_PORT || '81', 10);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function getProjectDeployConfig(project) {
  const projectDeployConfigPath = path.join(project.path, '.devmanager', 'nginx-config.json');
  return readJson(projectDeployConfigPath) || project.deploy_config || null;
}

function loadPersonalworkTarget() {
  return `http://127.0.0.1:${PERSONALWORK_PORT}`;
}

function loadRoutes() {
  const config = readJson(CONFIG_PATH) || {};
  const routes = [];

  for (const project of config.monitored_projects || []) {
    if (!project.active || project.id === 'personalwork') continue;

    const deployConfig = getProjectDeployConfig(project);
    if (!deployConfig || deployConfig.enabled === false || !deployConfig.port) continue;

    const nginxPath = String(deployConfig.nginx_path || project.id).replace(/^\/+|\/+$/g, '');
    if (!nginxPath) continue;

    routes.push({
      projectId: project.id,
      prefix: `/${nginxPath}/`,
      target: `http://127.0.0.1:${deployConfig.port}`,
      stripPrefix: deployConfig.strip_prefix === true
    });
  }

  // Longer prefixes first, so nested paths are matched predictably.
  return routes.sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolveRoute(url) {
  const pathname = new URL(url, 'http://localhost').pathname;

  const routes = loadRoutes();
  for (const route of routes) {
    const barePrefix = route.prefix.slice(0, -1);
    if (pathname === barePrefix || pathname.startsWith(route.prefix)) {
      return { target: route.target, stripPrefix: route.stripPrefix ? route.prefix : null };
    }
  }

  return { target: loadPersonalworkTarget(), stripPrefix: null };
}

function stripProxyPrefix(req, prefix) {
  if (!prefix) return null;
  const originalUrl = req.url;
  const barePrefix = prefix.slice(0, -1);
  const parsedUrl = new URL(req.url, 'http://localhost');

  if (parsedUrl.pathname === barePrefix) {
    parsedUrl.pathname = '/';
    req.url = parsedUrl.pathname + parsedUrl.search;
  } else if (parsedUrl.pathname.startsWith(prefix)) {
    parsedUrl.pathname = parsedUrl.pathname.slice(prefix.length - 1) || '/';
    req.url = parsedUrl.pathname + parsedUrl.search;
  }

  return originalUrl;
}

const server = http.createServer((req, res) => {
  const { target, stripPrefix } = resolveRoute(req.url);
  const originalUrl = stripProxyPrefix(req, stripPrefix);
  proxy.web(req, res, { target }, (err) => {
    if (originalUrl) req.url = originalUrl;
    console.error(`[Proxy] ${originalUrl || req.url} -> ${target} 失败:`, err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Bad Gateway: ${err.message}\n`);
  });
  if (originalUrl) {
    res.on('finish', () => {
      req.url = originalUrl;
    });
  }
});

server.on('upgrade', (req, socket, head) => {
  const { target, stripPrefix } = resolveRoute(req.url);
  const originalUrl = stripProxyPrefix(req, stripPrefix);
  proxy.ws(req, socket, head, { target }, (err) => {
    if (originalUrl) req.url = originalUrl;
    console.error(`[Proxy] WS ${originalUrl || req.url} -> ${target} 失败:`, err.message);
    socket.destroy();
  });
});

const PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 80;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Port collision is the expected case when NginxManager (or any other
    // reverse proxy) already owns port 80. Log a warning instead of
    // crashing so supervisors don't enter a restart loop. Set
    // DEVMANAGER_DISABLE_PROXY_JS=1 to suppress proxy.js entirely.
    console.warn(
      `[Proxy] 端口 ${PORT} 已被占用 — 假定另一个反向代理（如 nginx 引擎）已接管。`
    );
    console.warn(
      '[Proxy] 提示: 设置 DEVMANAGER_DISABLE_PROXY_JS=1 可让本脚本在启动时直接退出，' +
        '避免重复尝试。'
    );
    // Exit 0 so launchd / systemd treat this as a successful no-op.
    process.exit(0);
  } else if (err.code === 'EACCES' || err.code === 'EPERM') {
    console.error(`[Proxy] 无权限监听端口 ${PORT}，80 端口请使用 sudo 启动`);
    process.exit(1);
  } else {
    console.error('[Proxy] 启动失败:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  const routes = loadRoutes();
  const personalworkTarget = loadPersonalworkTarget();
  console.log(`[Proxy] 反向代理已启动: http://localhost:${PORT}`);
  console.log(`[Proxy] /        -> ${personalworkTarget} (PersonalWork)`);
  for (const route of routes) {
    console.log(`[Proxy] ${route.prefix} -> ${route.target} (${route.projectId})`);
  }
  console.log(`[Proxy] DevManager 后台: http://localhost:${DEVMANAGER_PORT} (不通过 80 代理)`);
  if (PORT < 1024) {
    console.log('[Proxy] 注意: 80 端口需要 root 权限启动');
  }
});
