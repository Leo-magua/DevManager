/**
 * NLP 解析路由
 */
const express = require('express');
const { getNLParser } = require('../services/nl-parser');

function createNLPRoutes() {
  const router = express.Router();
  const nlParser = getNLParser();

  router.post('/parse', async (req, res) => {
    const { input, project_id } = req.body;

    if (!input) {
      return res.status(400).json({ error: '输入不能为空' });
    }

    try {
      const parsed = await nlParser.parse(input, { projectId: project_id });
      res.json({
        success: true,
        input,
        parsed,
        suggested_actions: [
          {
            action: parsed.operation,
            description: parsed.operation === 'create' ? '创建新需求' :
                        parsed.operation === 'update' ? '更新现有需求' :
                        parsed.operation === 'delete' ? '删除需求' : '查询需求'
          }
        ]
      });
    } catch (err) {
      res.status(500).json({ error: '解析失败', message: err.message });
    }
  });

  return router;
}

module.exports = { createNLPRoutes };
