/**
 * Nginx 配置管理器
 * 
 * 统一管理 AllProject 下所有项目的反向代理配置
 * - 扫描项目时自动生成 Nginx 路由
 * - 支持自定义路径、端口映射
 * - 自动重载 Nginx 服务
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { getConfig, saveConfig } = require('../config');
const { broadcast } = require('../websocket/broadcast');

// Nginx 配置文件路径 (macOS Homebrew)
const NGINX_PREFIX = process.env.NGINX_PREFIX || process.env.HOMEBREW_PREFIX || '/opt/homebrew';
const NGINX_CONFIG_DIR = process.env.NGINX_CONFIG_DIR || `${NGINX_PREFIX}/etc/nginx/servers`;
const NGINX_MAIN_CONFIG = process.env.NGINX_MAIN_CONFIG || `${NGINX_PREFIX}/etc/nginx/nginx.conf`;
const DEVMANAGER_NGINX_CONFIG = path.join(NGINX_CONFIG_DIR, 'devmanager-projects.conf');
const NGINX_BIN = process.env.NGINX_BIN || `${NGINX_PREFIX}/bin/nginx`;
const PERSONALWORK_PORT = parseInt(process.env.PERSONALWORK_PORT || '3991', 10);

// 项目部署配置模板
const DEPLOY_TEMPLATES = {
  // React/Vite 前端项目
  vite: {
    type: 'frontend',
    defaultPort: 8080,
    locationTemplate: (config, port) => `
    # ${config.project_name} - Vite/React 前端项目
    location /${config.nginx_path || config.project_id}/ {
        proxy_pass http://127.0.0.1:${port}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }`,
  },
  
  // Python Flask/FastAPI
  python: {
    type: 'backend',
    defaultPort: 5000,
    locationTemplate: (config, port) => `
    # ${config.project_name} - Python 后端项目
    location /${config.nginx_path || config.project_id}/ {
        proxy_pass http://127.0.0.1:${port}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持（Python 实时通信）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 长连接超时
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }`,
  },
  
  // Node.js/Express
  nodejs: {
    type: 'backend',
    defaultPort: 3000,
    locationTemplate: (config, port) => `
    # ${config.project_name} - Node.js 后端项目
    location /${config.nginx_path || config.project_id}/ {
        proxy_pass http://127.0.0.1:${port}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }`,
  },
  
  // 静态网站
  static: {
    type: 'static',
    defaultPort: null,
    locationTemplate: (config, port) => `
    # ${config.project_name} - 静态网站
    location /${config.nginx_path || config.project_id}/ {
        alias ${config.project_path || ''}/dist/;
        index index.html;
        try_files $uri $uri/ /${config.nginx_path || config.project_id}/index.html;
    }`,
  },
};

class NginxManager {
  constructor() {
    this.configStatus = {
      valid: false,
      lastCheck: null,
      error: null
    };
    this.projectsConfig = new Map(); // projectId -> deployConfig
  }

  /**
   * 检测项目类型，推荐部署模板
   */
  detectProjectType(projectPath) {
    const checks = [
      { file: 'vite.config.ts', type: 'vite' },
      { file: 'vite.config.js', type: 'vite' },
      { file: 'package.json', check: (content) => {
        try {
          const pkg = JSON.parse(content);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.vite) return 'vite';
          if (deps.express || deps.fastify || deps.koa) return 'nodejs';
          if (deps.next) return 'nodejs';
        } catch {}
        return null;
      }},
      { file: 'requirements.txt', type: 'python' },
      { file: 'app.py', type: 'python' },
      { file: 'server.py', type: 'python' },
      { file: 'production_server.py', type: 'python' },
    ];

    // 同步检查（简化版，实际使用异步）
    for (const check of checks) {
      try {
        const content = require('fs').readFileSync(path.join(projectPath, check.file), 'utf-8');
        if (check.check) {
          const result = check.check(content);
          if (result) return result;
        } else {
          return check.type;
        }
      } catch {}
    }

    // 检查是否有 dist 或 build 目录
    try {
      require('fs').accessSync(path.join(projectPath, 'dist'));
      return 'static';
    } catch {}

    return 'nodejs'; // 默认
  }

  /**
   * 为项目生成默认部署配置
   */
  generateDeployConfig(project, projectType = null) {
    const type = projectType || this.detectProjectType(project.path);
    const template = DEPLOY_TEMPLATES[type];
    
    // 生成唯一端口（基于项目名哈希）
    const port = this.generatePort(project.id, template.defaultPort);
    
    const config = {
      project_id: project.id,
      project_name: project.name,
      project_path: project.path,
      type: type,
      enabled: true,
      nginx_path: project.id, // URL 路径，如 /chickennote
      port: port,
      template: type,
      custom_config: null, // 用户自定义配置
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return config;
  }

  /**
   * 生成唯一端口
   */
  generatePort(projectId, defaultPort = 3000) {
    // 基于项目名生成确定性端口 (3000-9000)
    let hash = 0;
    for (let i = 0; i < projectId.length; i++) {
      hash = ((hash << 5) - hash) + projectId.charCodeAt(i);
      hash = hash & hash;
    }
    const portRange = 6000; // 3000-9000
    return 3000 + (Math.abs(hash) % portRange);
  }

  /**
   * 检查端口是否被占用
   */
  async isPortInUse(port) {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} | grep LISTEN | wc -l`);
      return parseInt(stdout.trim()) > 0;
    } catch {
      return false;
    }
  }

  /**
   * 为项目分配新端口（如果被占用）
   */
  async allocatePort(projectId, preferredPort) {
    let port = preferredPort;
    let attempts = 0;
    
    while (await this.isPortInUse(port) && attempts < 100) {
      port = 3000 + Math.floor(Math.random() * 6000);
      attempts++;
    }
    
    return port;
  }

  /**
   * 添加/更新项目部署配置
   */
  async addProjectDeployConfig(project, customConfig = {}, detectExisting = false) {
    const existing = this.projectsConfig.get(project.id);
    
    let config;
    if (existing) {
      config = {
        ...existing,
        ...customConfig,
        updated_at: new Date().toISOString()
      };
    } else {
      const defaultConfig = this.generateDeployConfig(project);
      config = {
        ...defaultConfig,
        ...customConfig
      };
    }

    // 如果要求检测现有端口，尝试获取
    if (detectExisting && !customConfig.port) {
      const detectedPort = await this.detectActualPort(project.path);
      if (detectedPort) {
        config.port = detectedPort;
        console.log(`[NginxManager] 检测到 ${project.id} 现有端口: ${detectedPort}`);
      }
    }

    // 确保端口可用
    if (!existing || customConfig.port) {
      const actualPort = await this.allocatePort(project.id, config.port);
      config.port = actualPort;
    }

    this.projectsConfig.set(project.id, config);
    
    // 保存到项目配置
    await this.saveProjectNginxConfig(project.id, config);
    
    console.log(`[NginxManager] 项目 ${project.id} 部署配置已${existing ? '更新' : '添加'}: ${config.type} -> :${config.port}`);
    
    broadcast('nginx_config_updated', { project_id: project.id, config });
    
    return config;
  }

  /**
   * 生成 Nginx 配置内容
   */
  generateNginxConfig() {
    const config = getConfig();
    const mainPort = 80; // 统一入口端口
    const personalworkConfig = this.projectsConfig.get('personalwork');
    const personalworkPort = personalworkConfig?.enabled !== false && personalworkConfig?.port
      ? personalworkConfig.port
      : PERSONALWORK_PORT;
    
    let nginxConfig = `# Auto-generated by DevManager
# Generated at: ${new Date().toISOString()}
# DO NOT EDIT MANUALLY - Use DevManager API instead

# PersonalWork 主入口 (80端口)
server {
    listen ${mainPort};
    server_name _;
    
    # 默认首页 - PersonalWork 前端
    location / {
        proxy_pass http://127.0.0.1:${personalworkPort}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
`;

    // 添加各项目配置
    for (const [projectId, deployConfig] of this.projectsConfig) {
      if (projectId === 'personalwork') continue;
      if (!deployConfig.enabled) continue;
      
      const template = DEPLOY_TEMPLATES[deployConfig.template];
      if (!template) continue;
      
      // 使用自定义配置或模板
      if (deployConfig.custom_config) {
        nginxConfig += deployConfig.custom_config;
      } else {
        nginxConfig += template.locationTemplate(deployConfig, deployConfig.port);
      }
    }

    nginxConfig += `\n}`

    return nginxConfig;
  }

  /**
   * 保存 Nginx 配置文件
   */
  async saveNginxConfig() {
    try {
      const configContent = this.generateNginxConfig();
      
      // 确保目录存在
      await fs.mkdir(NGINX_CONFIG_DIR, { recursive: true });
      
      // 写入配置
      await fs.writeFile(DEVMANAGER_NGINX_CONFIG, configContent, 'utf-8');
      
      console.log(`[NginxManager] Nginx 配置已保存: ${DEVMANAGER_NGINX_CONFIG}`);
      
      // 验证配置
      const valid = await this.validateConfig();
      
      return {
        success: true,
        path: DEVMANAGER_NGINX_CONFIG,
        valid: valid,
        config: configContent
      };
    } catch (err) {
      console.error('[NginxManager] 保存配置失败:', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 保存单个项目的 Nginx 配置到项目目录（供参考）
   */
  async saveProjectNginxConfig(projectId, deployConfig) {
    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) return;

      const nginxConfigPath = path.join(project.path, '.devmanager', 'nginx-config.json');
      await fs.mkdir(path.dirname(nginxConfigPath), { recursive: true });
      await fs.writeFile(nginxConfigPath, JSON.stringify(deployConfig, null, 2));
    } catch (err) {
      console.error('[NginxManager] 保存项目配置失败:', err.message);
    }
  }

  /**
   * 验证 Nginx 配置
   */
  async validateConfig() {
    try {
      const { stdout, stderr } = await execAsync(`${NGINX_BIN} -t`);
      this.configStatus = {
        valid: true,
        lastCheck: new Date().toISOString(),
        error: null
      };
      return true;
    } catch (err) {
      this.configStatus = {
        valid: false,
        lastCheck: new Date().toISOString(),
        error: err.message
      };
      return false;
    }
  }

  /**
   * 重载 Nginx 服务
   */
  async reloadNginx() {
    try {
      // 先验证配置
      const valid = await this.validateConfig();
      if (!valid) {
        return {
          success: false,
          error: 'Nginx 配置验证失败，无法重载',
          status: this.configStatus
        };
      }

      // 重载服务
      await execAsync(`sudo ${NGINX_BIN} -s reload`);
      
      console.log('[NginxManager] Nginx 服务已重载');
      
      broadcast('nginx_reloaded', { timestamp: new Date().toISOString() });
      
      return {
        success: true,
        message: 'Nginx 配置已重载'
      };
    } catch (err) {
      console.error('[NginxManager] 重载 Nginx 失败:', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 获取所有项目的部署配置
   */
  getAllDeployConfigs() {
    const configs = [];
    for (const [projectId, config] of this.projectsConfig) {
      configs.push({
        project_id: projectId,
        ...config
      });
    }
    return configs;
  }

  /**
   * 获取单个项目的部署配置
   */
  getDeployConfig(projectId) {
    return this.projectsConfig.get(projectId) || null;
  }

  /**
   * 更新项目部署配置
   */
  async updateDeployConfig(projectId, updates) {
    const existing = this.projectsConfig.get(projectId);
    if (!existing) {
      return { error: '项目部署配置不存在' };
    }

    const config = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString()
    };

    this.projectsConfig.set(projectId, config);
    await this.saveProjectNginxConfig(projectId, config);

    return { success: true, config };
  }

  /**
   * 生成项目的启动命令
   */
  resolvePackageDir(project) {
    const candidates = [
      project.path,
      path.join(project.path, 'app'),
      path.join(project.path, 'frontend'),
      path.join(project.path, 'client'),
      path.join(project.path, 'web'),
      path.join(project.path, 'server')
    ];

    return candidates.find(dir => fsSync.existsSync(path.join(dir, 'package.json'))) || project.path;
  }

  resolvePythonEntry(project) {
    const dirs = [
      project.path,
      path.join(project.path, 'backend'),
      path.join(project.path, 'server'),
      path.join(project.path, 'app')
    ];
    const files = ['production_server.py', 'server.py', 'app.py', 'main.py'];

    for (const dir of dirs) {
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (fsSync.existsSync(filePath)) {
          return { cwd: dir, file };
        }
      }
    }

    return { cwd: project.path, file: 'production_server.py' };
  }

  getPythonBin(cwd) {
    const venvPythonPath = path.join(cwd, 'venv', 'bin', 'python');
    return fsSync.existsSync(venvPythonPath) ? './venv/bin/python' : 'python3';
  }

  generateStartCommand(project, deployConfig) {
    const template = DEPLOY_TEMPLATES[deployConfig.template];
    const basePath = `/${String(deployConfig.nginx_path || project.id).replace(/^\/+|\/+$/g, '')}/`;
    
    switch (deployConfig.template) {
      case 'vite': {
        const cwd = this.resolvePackageDir(project);
        let command = `npx vite preview --host 0.0.0.0 --port ${deployConfig.port}`;
        try {
          const pkg = JSON.parse(fsSync.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
          if (pkg.scripts?.preview) {
            command = `npm run preview -- --host 0.0.0.0 --port ${deployConfig.port}`;
          }
        } catch {}
        return {
          command,
          env: {
            ...process.env,
            CI: 'true',
            NODE_ENV: 'production',
            PORT: String(deployConfig.port),
            HOST: '0.0.0.0',
            BASE_PATH: basePath,
            VITE_BASE_PATH: basePath
          },
          cwd
        };
      }
      
      case 'python': {
        const entry = this.resolvePythonEntry(project);
        const pythonBin = this.getPythonBin(entry.cwd);
        const isFastApi = entry.file === 'main.py';
        return {
          command: isFastApi
            ? `${pythonBin} -m uvicorn main:app --host 0.0.0.0 --port ${deployConfig.port}`
            : `${pythonBin} ${entry.file}`,
          env: { ...process.env, PORT: String(deployConfig.port) },
          cwd: entry.cwd
        };
      }
      
      case 'nodejs': {
        const cwd = this.resolvePackageDir(project);
        let command = `PORT=${deployConfig.port} npm start`;
        try {
          const pkg = JSON.parse(fsSync.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
          if (pkg.scripts?.preview) {
            command = `npm run preview -- --host 0.0.0.0 --port ${deployConfig.port}`;
          } else if (pkg.scripts?.dev) {
            command = `npm run dev -- --host 0.0.0.0 --port ${deployConfig.port}`;
          }
        } catch {}
        return {
          command,
          env: {
            ...process.env,
            CI: 'true',
            PORT: String(deployConfig.port),
            HOST: '0.0.0.0',
            BASE_PATH: basePath,
            VITE_BASE_PATH: basePath
          },
          cwd
        };
      }
      
      case 'static':
        return {
          command: `python -m http.server ${deployConfig.port} --bind 0.0.0.0`,
          cwd: path.join(project.path, 'dist')
        };
      
      default:
        return {
          command: `echo "请手动配置 ${project.name} 的启动命令"`,
          cwd: project.path
        };
    }
  }

  /**
   * 获取系统状态
   */
  async getStatus() {
    const nginxRunning = await this.isNginxRunning();
    const configs = this.getAllDeployConfigs();
    
    return {
      nginx_running: nginxRunning,
      nginx_config_path: DEVMANAGER_NGINX_CONFIG,
      config_valid: this.configStatus.valid,
      last_check: this.configStatus.lastCheck,
      projects_configured: configs.length,
      projects: configs,
      main_entry: {
        url: 'http://YOUR_IP/',
        target: `http://127.0.0.1:${this.projectsConfig.get('personalwork')?.port || PERSONALWORK_PORT}`,
        description: 'PersonalWork 主入口'
      }
    };
  }

  /**
   * 检查 Nginx 是否运行
   */
  async isNginxRunning() {
    try {
      const { stdout } = await execAsync('pgrep nginx | wc -l');
      return parseInt(stdout.trim()) > 0;
    } catch {
      return false;
    }
  }

  /**
   * 启动 Nginx（macOS 需要 sudo 才能绑定 80 端口）
   */
  async startNginx() {
    try {
      await execAsync(`sudo ${NGINX_BIN}`);
      console.log('[NginxManager] Nginx 已启动');
      return { success: true };
    } catch (err) {
      console.error('[NginxManager] 启动 Nginx 失败:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 初始化：扫描现有项目并生成配置
   */
  async initialize() {
    console.log('[NginxManager] 初始化中...');
    
    const config = getConfig();
    
    for (const project of config.monitored_projects) {
      // 检查项目是否已有部署配置
      const existingConfigPath = path.join(project.path, '.devmanager', 'nginx-config.json');
      
      try {
        const data = await fs.readFile(existingConfigPath, 'utf-8');
        const deployConfig = JSON.parse(data);
        if (project.id === 'personalwork') {
          deployConfig.port = PERSONALWORK_PORT;
          deployConfig.nginx_path = '';
          deployConfig.updated_at = new Date().toISOString();
          await this.saveProjectNginxConfig(project.id, deployConfig);
        }
        this.projectsConfig.set(project.id, deployConfig);
        console.log(`[NginxManager] 加载已有配置: ${project.id}`);
      } catch {
        // 生成新配置，但尝试检测现有服务的实际端口
        const deployConfig = await this.addProjectDeployConfig(project, {}, true);
        console.log(`[NginxManager] 生成新配置: ${project.id} -> :${deployConfig.port}`);
      }
    }
    
    // 保存完整 Nginx 配置
    await this.saveNginxConfig();
    
    console.log(`[NginxManager] 初始化完成，共 ${this.projectsConfig.size} 个项目`);
  }

  /**
   * 检测项目当前实际使用的端口
   */
  async detectActualPort(projectPath) {
    try {
      // 检查常见的端口配置
      // 1. Python 文件中的硬编码端口
      const pyFiles = ['production_server.py', 'server.py', 'app.py'];
      for (const pyFile of pyFiles) {
        try {
          const content = await fs.readFile(path.join(projectPath, pyFile), 'utf-8');
          // 匹配 "0.0.0.0", 5002 或 port = 5002 等模式
          const match = content.match(/\(\s*["']0\.0\.0\.0["']\s*,\s*(\d+)\s*\)/);
          if (match) return parseInt(match[1]);
          
          const match2 = content.match(/port\s*=\s*(\d+)/i);
          if (match2) return parseInt(match2[1]);
        } catch {}
      }
      
      // 2. package.json 中的 scripts
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8'));
        if (pkg.scripts?.start?.includes('--port')) {
          const match = pkg.scripts.start.match(/--port\s+(\d+)/);
          if (match) return parseInt(match[1]);
        }
        if (pkg.scripts?.preview?.includes('--port')) {
          const match = pkg.scripts.preview.match(/--port\s+(\d+)/);
          if (match) return parseInt(match[1]);
        }
      } catch {}
      
      // 3. .env 文件
      try {
        const envContent = await fs.readFile(path.join(projectPath, '.env'), 'utf-8');
        const match = envContent.match(/PORT\s*=\s*(\d+)/);
        if (match) return parseInt(match[1]);
      } catch {}
      
    } catch {}
    return null;
  }
}

const nginxManager = new NginxManager();

module.exports = {
  nginxManager,
  getNginxManager: () => nginxManager,
  NGINX_CONFIG_DIR,
  DEVMANAGER_NGINX_CONFIG
};
