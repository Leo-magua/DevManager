/**
 * 路由公共工具函数
 */
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');

const SUPPORTED_TOOL_TYPES = ['kimi', 'cursor', 'codex'];
const DEFAULT_TOOL_TYPE = 'kimi';

function normalizeToolType(toolType, fallback = DEFAULT_TOOL_TYPE) {
  return SUPPORTED_TOOL_TYPES.includes(toolType) ? toolType : fallback;
}

// 扫描项目目录（返回实际存在的目录列表）
async function scanProjects() {
  const config = getConfig();
  const projects = [];
  try {
    const entries = await fs.readdir(config.projects_root, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'DevManager') {
        const projectPath = path.join(config.projects_root, entry.name);
        const hasPackageJson = await fs.access(path.join(projectPath, 'package.json')).then(() => true).catch(() => false);

        if (hasPackageJson) {
          projects.push({
            id: entry.name.toLowerCase(),
            name: entry.name,
            path: projectPath,
            detected: true
          });
        }
      }
    }
  } catch (err) {
    console.error('[扫描] 失败:', err.message);
  }
  return projects;
}

// 读取项目数据文件
async function readProjectData(projectConfig) {
  const { path: projectPath, key_files = {} } = projectConfig;
  const result = {
    project: projectConfig,
    data: { dev_state: null, user_backlog: null, status_md: null },
    error: null
  };

  try {
    const files = {
      dev_state: path.join(projectPath, key_files.dev_state || 'dev_state.json'),
      user_backlog: path.join(projectPath, key_files.user_backlog || 'user_backlog.json')
    };

    const defaults = {
      dev_state: {
        project: { name: path.basename(projectPath) },
        feature_list: [],
        current_context: {
          agent_task_id: null,
          task_name: '等待指令',
          start_time: null,
          last_error: null,
          trial_count: 0
        },
        changelog: []
      },
      user_backlog: { version: '1.0', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: [] }
    };

    for (const [key, filePath] of Object.entries(files)) {
      try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf-8');
        result.data[key] = JSON.parse(data);
      } catch {
        await fs.writeFile(filePath, JSON.stringify(defaults[key], null, 2));
        result.data[key] = defaults[key];
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  SUPPORTED_TOOL_TYPES,
  DEFAULT_TOOL_TYPE,
  normalizeToolType,
  scanProjects,
  readProjectData
};
