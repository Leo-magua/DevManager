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

  const publicWriteMatchers = [
    /^\/auth\/login$/,
    /^\/auth\/logout$/,
    /^\/tasks\/[^/]+\/complete$/,
    /^\/tasks\/[^/]+\/fail$/,
    /^\/queue\/claim$/,
    /^\/queue\/complete$/,
    /^\/queue\/error$/,
    /^\/queue\/log$/
  ];

  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    if (publicWriteMatchers.some(pattern => pattern.test(req.path))) {
      return next();
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
