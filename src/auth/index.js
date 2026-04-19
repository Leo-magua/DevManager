const crypto = require('crypto');
const { getConfig } = require('../config');

const COOKIE_NAME = 'devmanager_auth';
const sessions = new Map();

function getAuthConfig() {
  const config = getConfig();
  const auth = config.auth || {};
  const sessionTtlHours = Number(auth.session_ttl_hours) > 0 ? Number(auth.session_ttl_hours) : 24;

  return {
    enabled: !!getConfiguredPassword(),
    password: getConfiguredPassword(),
    sessionTtlHours
  };
}

function getConfiguredPassword() {
  const config = getConfig();
  return process.env.DEVMANAGER_PASSWORD || config.auth?.password || '';
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[COOKIE_NAME] || '';
}

function hasValidSession(req) {
  cleanupExpiredSessions();
  const token = getSessionTokenFromRequest(req);
  if (!token) return false;

  const session = sessions.get(token);
  if (!session) return false;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function hasValidPasswordHeader(req) {
  const configuredPassword = getConfiguredPassword();
  if (!configuredPassword) return false;

  const headerPassword = req.headers['x-devmanager-password'];
  if (headerPassword && headerPassword === configuredPassword) {
    return true;
  }

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === configuredPassword;
  }

  return false;
}

function isAuthenticated(req) {
  return hasValidSession(req) || hasValidPasswordHeader(req);
}

function createSession() {
  cleanupExpiredSessions();
  const { sessionTtlHours } = getAuthConfig();
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + sessionTtlHours * 60 * 60 * 1000;

  sessions.set(token, { token, expiresAt });
  return { token, expiresAt, maxAge: sessionTtlHours * 60 * 60 };
}

function clearSession(req) {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    sessions.delete(token);
  }
}

function buildCookie(token, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function buildClearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', buildCookie(token, maxAge));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildClearedCookie());
}

function getAuthStatus(req) {
  const auth = getAuthConfig();
  return {
    enabled: auth.enabled,
    authenticated: auth.enabled ? isAuthenticated(req) : true,
    session_ttl_hours: auth.sessionTtlHours
  };
}

function requireWriteAccess(req, res, next) {
  const auth = getAuthConfig();
  if (!auth.enabled) {
    return res.status(503).json({
      error: 'AUTH_NOT_CONFIGURED',
      message: '开发权限密码尚未配置'
    });
  }

  if (isAuthenticated(req)) {
    return next();
  }

  return res.status(401).json({
    error: 'AUTH_REQUIRED',
    message: '开发相关操作需要先输入密码'
  });
}

module.exports = {
  COOKIE_NAME,
  clearSession,
  clearSessionCookie,
  createSession,
  getAuthConfig,
  getAuthStatus,
  getConfiguredPassword,
  hasValidPasswordHeader,
  isAuthenticated,
  parseCookies,
  requireWriteAccess,
  setSessionCookie
};
