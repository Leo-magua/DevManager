/**
 * 项目扫描器
 */
const fs = require('fs').promises;
const path = require('path');
const { getConfig, saveConfig } = require('../config');
const { broadcast } = require('../websocket/broadcast');
const { getNginxManager } = require('../services/nginx-manager');
const { writeJsonAtomic } = require('../utils/atomic-write');

class ProjectScanner {
  constructor() {
    this.autoScanInterval = null;
    this.requiredFiles = ['dev_state.json', 'user_backlog.json'];
    this.optionalFiles = { '.kimi/status.md': '# 项目状态\n\n## 当前状态\n- 项目运行正常\n\n## 最近更新\n- 自动创建\n' };
  }

  async scan() {
    const config = getConfig();
    const results = {
      scanned: 0,
      added: [],
      removed: [],
      updated: [],
      errors: [],
      timestamp: new Date().toISOString()
    };

    try {
      // 1. 扫描目录获取实际存在的项目
      const entries = await fs.readdir(config.projects_root, { withFileTypes: true });
      const existingProjectPaths = new Set();
      const existingProjectIds = new Set();
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'DevManager') continue;
        
        const projectPath = path.join(config.projects_root, entry.name);
        existingProjectPaths.add(projectPath);
        existingProjectIds.add(entry.name.toLowerCase());
      }
      
      // 2. 清理已不存在的项目（同步机制的关键）
      const originalCount = config.monitored_projects.length;
      const validMonitored = [];
      const seenIds = new Set();
      
      for (const p of config.monitored_projects) {
        const pIdLower = p.id.toLowerCase();
        
        // 跳过重复ID的项目
        if (seenIds.has(pIdLower)) {
          console.log(`[ProjectScanner] 跳过重复项目: ${p.id}`);
          continue;
        }
        
        // 检查项目是否仍然存在（通过路径或ID）
        const pathExists = existingProjectPaths.has(p.path);
        const idExists = existingProjectIds.has(pIdLower);
        
        if (pathExists || idExists) {
          seenIds.add(pIdLower);
          validMonitored.push(p);
        } else {
          results.removed.push({ id: p.id, name: p.name, path: p.path });
          console.log(`[ProjectScanner] 清理已删除项目: ${p.id} (${p.name})`);
        }
      }
      
      if (results.removed.length > 0) {
        config.monitored_projects = validMonitored;
      }
      
      // 3. 处理新增项目
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'DevManager') continue;
        
        const projectPath = path.join(config.projects_root, entry.name);
        results.scanned++;

        try {
          const projectResult = await this.ensureProjectFiles(projectPath, entry.name);
          
          if (projectResult.created.length > 0) {
            results.updated.push({
              name: entry.name,
              path: projectPath,
              created: projectResult.created
            });
          }

          const existingProject = config.monitored_projects.find(p => 
            p.id.toLowerCase() === entry.name.toLowerCase() || p.path === projectPath
          );

          if (!existingProject) {
            const newProject = await this.addProjectToConfig(entry.name, projectPath);
            results.added.push(newProject);
          }
        } catch (err) {
          results.errors.push({ name: entry.name, error: err.message });
        }
      }

      // 4. 保存配置（如果有新增或删除）
      if (results.added.length > 0 || results.removed.length > 0) {
        await saveConfig();
      }

      console.log(`[ProjectScanner] 扫描完成: ${results.scanned} 个目录, ${results.added.length} 个新增, ${results.removed.length} 个删除, ${results.updated.length} 个更新`);
      broadcast('scan_complete', results);
      
    } catch (err) {
      console.error('[ProjectScanner] 扫描失败:', err.message);
      results.errors.push({ name: 'root', error: err.message });
    }

    return results;
  }

  async ensureProjectFiles(projectPath, projectName) {
    const result = { created: [], existing: [] };

    // dev_state.json
    const devStatePath = path.join(projectPath, 'dev_state.json');
    try {
      await fs.access(devStatePath);
      result.existing.push('dev_state.json');
    } catch {
      const defaultDevState = {
        project: {
          name: projectName,
          current_stage: 'initialized',
          tech_stack: { detected: 'auto' }
        },
        feature_list: [],
        current_context: {
          agent_task_id: null,
          task_name: '等待指令',
          start_time: null,
          last_error: null,
          trial_count: 0
        },
        changelog: [{
          timestamp: new Date().toISOString(),
          type: 'system',
          message: '项目被扫描并自动初始化',
          details: '自动创建了 dev_state.json'
        }],
        updated_at: new Date().toISOString()
      };
      await writeJsonAtomic(devStatePath, defaultDevState);
      result.created.push('dev_state.json');
    }

    // user_backlog.json
    const backlogPath = path.join(projectPath, 'user_backlog.json');
    try {
      await fs.access(backlogPath);
      result.existing.push('user_backlog.json');
    } catch {
      const defaultBacklog = {
        version: '1.0',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      };
      await writeJsonAtomic(backlogPath, defaultBacklog);
      result.created.push('user_backlog.json');
    }

    // .kimi/status.md
    const kimiDir = path.join(projectPath, '.kimi');
    const statusPath = path.join(kimiDir, 'status.md');
    try {
      await fs.access(statusPath);
      result.existing.push('.kimi/status.md');
    } catch {
      await fs.mkdir(kimiDir, { recursive: true });
      const defaultStatus = `# ${projectName} 项目状态

## 当前状态
- 项目已初始化
- 等待进一步开发指令

## 最近更新
- ${new Date().toLocaleString()} - 项目被扫描并自动初始化
`;
      await fs.writeFile(statusPath, defaultStatus);
      result.created.push('.kimi/status.md');
    }

    return result;
  }

  async addProjectToConfig(projectName, projectPath) {
    const config = getConfig();
    const projectId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const techStack = await this.detectTechStack(projectPath);
    
    const newProject = {
      id: projectId,
      name: projectName,
      path: projectPath,
      description: `自动发现的项目: ${projectName}`,
      default_tool_type: 'kimi',
      tech_stack: techStack,
      key_files: {
        dev_state: 'dev_state.json',
        user_backlog: 'user_backlog.json',
        status: '.kimi/status.md'
      },
      active: true,
      auto_detected: true,
      detected_at: new Date().toISOString()
    };

    config.monitored_projects.push(newProject);
    console.log(`[ProjectScanner] 添加新项目: ${projectName} (${projectId})`);
    
    // 自动生成 Nginx 部署配置
    try {
      const nginxManager = getNginxManager();
      const deployConfig = await nginxManager.addProjectDeployConfig(newProject);
      newProject.deploy_config = deployConfig;
      
      // 重新生成并保存 Nginx 配置
      await nginxManager.saveNginxConfig();
      
      console.log(`[ProjectScanner] 已为 ${projectId} 生成 Nginx 配置: ${deployConfig.type} -> :${deployConfig.port}`);
    } catch (err) {
      console.error(`[ProjectScanner] 生成 Nginx 配置失败: ${err.message}`);
    }
    
    return newProject;
  }

  async detectTechStack(projectPath) {
    const techStack = [];
    
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      try {
        const pkgData = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgData);
        
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        if (deps.react) techStack.push('React');
        if (deps.vue) techStack.push('Vue');
        if (deps.typescript) techStack.push('TypeScript');
        if (deps.vite) techStack.push('Vite');
        if (deps.tailwindcss || deps['tailwindcss']) techStack.push('Tailwind CSS');
        if (deps.express) techStack.push('Express');
        if (deps.next) techStack.push('Next.js');
        if (deps.flask) techStack.push('Flask');
        
        if (techStack.length === 0) {
          techStack.push('Node.js');
        }
      } catch {}

      const pyFiles = ['requirements.txt', 'setup.py', 'pyproject.toml'];
      for (const pyFile of pyFiles) {
        try {
          await fs.access(path.join(projectPath, pyFile));
          if (!techStack.includes('Python')) techStack.push('Python');
          break;
        } catch {}
      }

      if (!techStack.length) {
        techStack.push('Unknown');
      }
    } catch {
      techStack.push('Unknown');
    }

    return techStack;
  }

  startAutoScan(intervalMinutes = 5) {
    if (this.autoScanInterval) {
      clearInterval(this.autoScanInterval);
    }
    
    console.log(`[ProjectScanner] 自动扫描已启动 (${intervalMinutes}分钟间隔)`);
    
    this.autoScanInterval = setInterval(async () => {
      console.log('[ProjectScanner] 执行自动扫描...');
      await this.scan();
    }, intervalMinutes * 60 * 1000);
  }

  stopAutoScan() {
    if (this.autoScanInterval) {
      clearInterval(this.autoScanInterval);
      this.autoScanInterval = null;
      console.log('[ProjectScanner] 自动扫描已停止');
    }
  }

  getStatus() {
    const config = getConfig();
    return {
      auto_scan: this.autoScanInterval !== null,
      monitored_count: config.monitored_projects.length,
      projects_root: config.projects_root
    };
  }
}

const projectScanner = new ProjectScanner();

module.exports = {
  projectScanner,
  getProjectScanner: () => projectScanner
};
