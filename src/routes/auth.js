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

function createAuthRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json(getAuthStatus(req));
  });

  router.post('/login', express.json(), (req, res) => {
    const { password } = req.body || {};
    const configuredPassword = getConfiguredPassword();

    if (!configuredPassword) {
      return res.status(503).json({
        error: 'AUTH_NOT_CONFIGURED',
        message: '开发权限密码尚未配置'
      });
    }

    if (!verifyPassword(password, configuredPassword)) {
      return res.status(401).json({
        error: 'AUTH_INVALID',
        message: '密码错误'
      });
    }

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
