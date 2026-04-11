/**
 * 配置管理模块
 */
const fs = require('fs').promises;
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../..', 'config.json');

// 默认配置
let config = {
  app: { name: 'DevManager', port: 81 },
  projects_root: '/var/www/AllProject',
  monitored_projects: []
};

// 加载配置
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    config = JSON.parse(data);
    console.log('[配置] 已加载 config.json');
  } catch (err) {
    console.log('[配置] 使用默认配置');
  }
}

// 获取当前配置
function getConfig() {
  return config;
}

// 更新配置
function setConfig(newConfig) {
  config = { ...config, ...newConfig };
}

// 保存配置到文件
async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('[配置] 已保存');
  } catch (err) {
    console.error('[配置] 保存失败:', err.message);
  }
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  getConfig,
  setConfig,
  saveConfig
};
