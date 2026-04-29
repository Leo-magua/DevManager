/**
 * Express 路由组装入口
 */
const express = require('express');
const {
  requireWriteAccess
} = require('../auth');

const { createAuthRoutes } = require('./auth');
const { createProjectRoutes } = require('./projects');
const { createFeatureRoutes } = require('./features');
const { createQueueRoutes } = require('./queue');
const { createExecutorRoutes } = require('./executor');
const { createNLPRoutes } = require('./nlp');
const { createAIRoutes } = require('./ai');
const { createNginxRoutes } = require('./nginx');
const { createDeployRoutes } = require('./deploy');

function createRoutes() {
  const router = express.Router();

  // Endpoints fully public to unauthenticated users (login/logout only).
  const publicWriteMatchers = [
    /^\/auth\/login$/,
    /^\/auth\/logout$/
  ];

  // Worker/agent callback endpoints — not session-authed, but require a
  // shared-secret token so they can't be hit by arbitrary internet clients.
  const workerWriteMatchers = [
    /^\/tasks\/[^/]+\/complete$/,
    /^\/tasks\/[^/]+\/fail$/,
    /^\/queue\/claim$/,
    /^\/queue\/complete$/,
    /^\/queue\/error$/,
    /^\/queue\/log$/
  ];

  let warnedMissingSecret = false;
  function requireWorkerSecret(req, res, next) {
    const expected = process.env.WORKER_SHARED_SECRET;
    if (!expected) {
      if (!warnedMissingSecret) {
        // eslint-disable-next-line no-console
        console.warn('[security] WORKER_SHARED_SECRET is not set; rejecting worker callbacks');
        warnedMissingSecret = true;
      }
      return res.status(503).json({ error: 'worker secret not configured' });
    }
    const provided = req.get('x-worker-secret') || req.get('X-Worker-Secret');
    if (!provided || provided !== expected) {
      return res.status(401).json({ error: 'invalid or missing worker secret' });
    }
    return next();
  }

  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    if (publicWriteMatchers.some(pattern => pattern.test(req.path))) {
      return next();
    }

    if (workerWriteMatchers.some(pattern => pattern.test(req.path))) {
      return requireWorkerSecret(req, res, next);
    }

    return requireWriteAccess(req, res, next);
  });

  // 挂载各子路由
  router.use('/auth', createAuthRoutes());
  router.use('/', createProjectRoutes());
  router.use('/', createFeatureRoutes());
  router.use('/', createQueueRoutes());
  router.use('/', createExecutorRoutes());
  router.use('/nlp', createNLPRoutes());
  router.use('/ai', createAIRoutes());
  router.use('/nginx', createNginxRoutes());
  router.use('/deploy', createDeployRoutes());

  // Agent 直连路由
  router.use('/agent', require('./agent-direct'));

  return router;
}

module.exports = { createRoutes };
