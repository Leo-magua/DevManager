/**
 * 配置管理模块
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

const CONFIG_PATH = path.join(__dirname, '../..', 'config.json');
const DEFAULT_PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(os.homedir(), 'AllProject');

// 默认配置
let config = {
  app: { name: 'DevManager', port: 81 },
  projects_root: DEFAULT_PROJECTS_ROOT,
  monitored_projects: [],
  auth: {
    password: '',
    session_ttl_hours: 24
  }
};

function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$/.test(str);
}

function normalizeConfig(nextConfig = {}) {
  const auth = nextConfig.auth || {};
  let password = typeof auth.password === 'string' ? auth.password : '';

  // 如果是明文密码，自动迁移为 bcrypt hash
  if (password && !isBcryptHash(password)) {
    password = bcrypt.hashSync(password, 10);
    auth.password = password;
    nextConfig._passwordMigrated = true;
  }

  return {
    ...nextConfig,
    auth: {
      password,
      session_ttl_hours: Number(auth.session_ttl_hours) > 0 ? Number(auth.session_ttl_hours) : 24
    }
  };
}

// 加载配置
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    config = normalizeConfig(parsed);

    if (config._passwordMigrated) {
      delete config._passwordMigrated;
      await saveConfig();
      console.log('[配置] 密码已自动迁移为 bcrypt hash');
    }

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
  config = normalizeConfig({ ...config, ...newConfig });
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
