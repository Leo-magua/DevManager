/**
 * 认证相关路由
 */
const express = require('express');
const {
  clearSession,
  clearSessionCookie,
  createSession,
  getAuthStatus,
  getConfiguredPassword,
  requireWriteAccess,
  setSessionCookie,
  verifyPassword
} = require('../auth');

// ---------------------------------------------------------------------------
// 简单的内存级登录限流：每 IP 每分钟最多 N 次失败尝试。
// 仅防御 brute-force 暴力破解；多进程部署时各进程独立计数。
// ---------------------------------------------------------------------------
const LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '5', 10);
const loginAttempts = new Map(); // ip -> { count, resetAt }

function getClientIp(req) {
  // 仅信任 Express 解析后的 req.ip；如部署在反向代理后请配置 trust proxy。
  return (req.ip || req.connection?.remoteAddress || 'unknown').toString();
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    return { allowed: true, remaining: LOGIN_RATE_LIMIT_MAX, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };
  }
  return {
    allowed: entry.count < LOGIN_RATE_LIMIT_MAX,
    remaining: Math.max(0, LOGIN_RATE_LIMIT_MAX - entry.count),
    resetAt: entry.resetAt
  };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// 周期性清理过期条目，避免内存膨胀。
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt <= now) loginAttempts.delete(ip);
  }
}, LOGIN_RATE_LIMIT_WINDOW_MS).unref?.();

function createAuthRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json(getAuthStatus(req));
  });

  router.post('/login', express.json(), async (req, res) => {
    const ip = getClientIp(req);
    const rate = checkLoginRateLimit(ip);
    if (!rate.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'AUTH_RATE_LIMITED',
        message: `登录尝试过于频繁，请 ${retryAfterSec}s 后重试`,
        retry_after_seconds: retryAfterSec
      });
    }

    const { password } = req.body || {};
    const configuredPassword = getConfiguredPassword();

    if (!configuredPassword) {
      return res.status(503).json({
        error: 'AUTH_NOT_CONFIGURED',
        message: '开发权限密码尚未配置'
      });
    }

    let ok = false;
    try {
      ok = await verifyPassword(password, configuredPassword);
    } catch (err) {
      console.error('[auth] verifyPassword error:', err.message);
      ok = false;
    }

    if (!ok) {
      recordLoginFailure(ip);
      return res.status(401).json({
        error: 'AUTH_INVALID',
        message: '密码错误'
      });
    }

    resetLoginAttempts(ip);
    const session = createSession();
    setSessionCookie(res, session.token, session.maxAge);

    res.json({
      success: true,
      authenticated: true,
      session_ttl_hours: getAuthStatus(req).session_ttl_hours
    });
  });

  router.post('/logout', (req, res) => {
    clearSession(req);
    clearSessionCookie(res);
    res.json({ success: true, authenticated: false });
  });

  return router;
}

module.exports = { createAuthRoutes };
