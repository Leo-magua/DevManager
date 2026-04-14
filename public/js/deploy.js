    // ========== 部署管理弹窗 ==========
    let deployModalRefreshInterval = null;

    function openDeployModal() {
      document.getElementById('deploy-modal').classList.remove('hidden');
      loadDeploymentStatus();
      if (deployModalRefreshInterval) clearInterval(deployModalRefreshInterval);
      deployModalRefreshInterval = setInterval(loadDeploymentStatus, 5000);
    }
    function closeDeployModal() {
      document.getElementById('deploy-modal').classList.add('hidden');
      if (deployModalRefreshInterval) {
        clearInterval(deployModalRefreshInterval);
        deployModalRefreshInterval = null;
      }
    }
    function renderDeployServices(services) {
      const infoList = document.getElementById('deploy-mini-list');
      const stopList = document.getElementById('deploy-stop-list');
      
      if (!services || services.length === 0) {
        infoList.classList.add('hidden');
        infoList.innerHTML = '';
        stopList.classList.add('hidden');
        stopList.innerHTML = '';
        return;
      }
      
      infoList.classList.remove('hidden');
      infoList.innerHTML = '';
      stopList.classList.remove('hidden');
      stopList.innerHTML = '';
      
      services.forEach(svc => {
        // 左侧：PID + 状态点
        const infoItem = document.createElement('div');
        infoItem.className = 'flex items-center gap-2 text-xs';
        infoItem.innerHTML = `
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span class="text-gray-400 font-mono">PID ${svc.pid}</span>
        `;
        infoList.appendChild(infoItem);
        
        // 右侧：图标停止按钮
        const stopBtn = document.createElement('button');
        stopBtn.onclick = () => stopDeployService(svc.taskId);
        stopBtn.className = 'w-7 h-7 flex items-center justify-center rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors';
        stopBtn.title = '停止部署服务';
        stopBtn.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path></svg>
        `;
        stopList.appendChild(stopBtn);
      });
    }
    async function stopDeployService(taskId) {
      if (!currentProject || !confirm('确定要停止这个部署服务吗？')) return;
      try {
        const res = await fetch(`${API_BASE}/api/deploy/${currentProject}/services/${taskId}/stop`, {
          method: 'POST'
        });
        const data = await res.json();
        if (data.success) {
          showToast('服务已停止', 'success');
          refreshAllData();
        } else {
          showToast(data.error || '停止失败', 'error');
        }
      } catch (err) {
        showToast('停止失败: ' + err.message, 'error');
      }
    }
    let deploymentData = [];
    async function loadDeploymentStatus() {
      try {
        // 并行获取 Nginx 状态、所有项目、部署配置
        const [nginxRes, projectsRes, deployRes] = await Promise.all([
          fetch(`${API_BASE}/api/nginx/status`),
          fetch(`${API_BASE}/api/projects`),
          fetch(`${API_BASE}/api/nginx/deploy-configs`)
        ]);
        const nginxData = await nginxRes.json();
        const projectsData = await projectsRes.json();
        const deployData = await deployRes.json();
        
        // 更新 Nginx 状态栏
        const badge = document.getElementById('nginx-config-badge');
        if (nginxData.config_valid) {
          badge.textContent = '配置有效';
          badge.className = 'px-2 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-400';
        } else {
          badge.textContent = '配置无效';
          badge.className = 'px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400';
        }
        
        const allProjects = projectsData.projects || [];
        deploymentData = deployData.configs || [];
        
        // 构建部署配置映射
        const deployConfigMap = {};
        deploymentData.forEach(c => { deployConfigMap[c.project_id] = c; });
        
        // 并行获取所有有部署配置项目的端口运行状态（实时检测）
        const portStatusMap = {};
        await Promise.all(
          deploymentData.map(async (config) => {
            try {
              const statusRes = await fetch(`${API_BASE}/api/deploy/${config.project_id}/status`);
              portStatusMap[config.project_id] = await statusRes.json();
            } catch {
              portStatusMap[config.project_id] = { project_id: config.project_id, running: false };
            }
          })
        );
        
        // 渲染统一的项目+部署管理列表
        renderDeploymentList(allProjects, deployConfigMap, portStatusMap);
        
      } catch (err) {
        console.error('加载部署状态失败:', err);
        document.getElementById('deployment-list').innerHTML = 
          `<div class="text-sm text-red-400">加载失败: ${err.message}</div>`;
      }
    }
    function renderDeploymentList(allProjects, deployConfigMap, portStatusMap) {
      const container = document.getElementById('deployment-list');
      
      if (allProjects.length === 0) {
        container.innerHTML = '<div class="text-sm text-gray-500 italic text-center py-6">暂无项目，请先扫描项目目录</div>';
        return;
      }
      
      container.innerHTML = '';
      
      allProjects.forEach(project => {
        const isCurrent = project.id === currentProject;
        const deployConfig = deployConfigMap[project.id];
        const portStatus = deployConfig ? (portStatusMap[project.id] || { running: false }) : null;
        const isRunning = !!(portStatus && portStatus.running);
        
        const card = document.createElement('div');
        let cardClass = 'p-4 rounded-lg border transition-all cursor-pointer select-none ';
        if (isCurrent) {
          cardClass += 'bg-accent/10 border-accent/50 hover:border-accent';
        } else if (isRunning) {
          cardClass += 'bg-emerald-500/10 border-emerald-500/30 hover:border-emerald-500/60';
        } else {
          cardClass += 'bg-dark-800 border-dark-600 hover:border-dark-500';
        }
        card.className = cardClass;
        
        let dotColor = 'bg-gray-500';
        if (isCurrent) dotColor = 'bg-accent animate-pulse';
        else if (isRunning) dotColor = 'bg-emerald-400 animate-pulse';
        
        const techInfo = (project.tech_stack || []).join(' · ') || '未识别';
        const deployPortInfo = deployConfig ? ' | 端口 ' + deployConfig.port : '';
        
        let badges = '';
        if (isCurrent) {
          badges += '<span class="px-2 py-0.5 text-[10px] bg-accent/20 text-accent rounded border border-accent/30">当前项目</span>';
        }
        if (deployConfig) {
          badges += isRunning
            ? '<span class="px-2 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/30">已部署</span>'
            : '<span class="px-2 py-0.5 text-[10px] bg-gray-700 text-gray-400 rounded border border-gray-600">未运行</span>';
        }
        
        let deployControlsHtml = '';
        if (deployConfig) {
          const hostname = window.location.hostname;
          const nginxPath = deployConfig.nginx_path;
          const accessUrl = 'http://' + hostname + ':8080/' + nginxPath + '/';
          const startStopBtn = isRunning
            ? '<button onclick="stopProject(\'' + project.id + '\')" class="px-3 py-1.5 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded border border-red-500/30 transition-colors">停止</button>'
            : '<button onclick="startProject(\'' + project.id + '\')" class="px-3 py-1.5 text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded border border-emerald-500/30 transition-colors">启动</button>';
          deployControlsHtml = '<div class="mt-3 pt-3 border-t border-dark-600/50 flex items-center gap-2">' +
            '<a href="' + accessUrl + '" target="_blank" class="px-3 py-1.5 text-xs bg-dark-700 hover:bg-dark-600 text-gray-300 rounded border border-dark-500 transition-colors flex items-center gap-1">' +
            '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>访问</a>' +
            startStopBtn +
            '<button onclick="editProjectPort(\'' + project.id + '\', ' + deployConfig.port + ')" class="px-3 py-1.5 text-xs bg-dark-700 hover:bg-dark-600 text-gray-300 rounded border border-dark-500 transition-colors">修改端口</button>' +
            '</div>';
        }
        
        card.innerHTML =
          '<div class="flex items-center justify-between">' +
            '<div class="flex items-center gap-3 min-w-0">' +
              '<span class="w-2.5 h-2.5 rounded-full ' + dotColor + ' shrink-0"></span>' +
              '<div class="min-w-0">' +
                '<div class="text-sm font-medium text-white truncate">' + escapeHtml(project.name) + '</div>' +
                '<div class="text-xs text-gray-500 truncate">' + escapeHtml(techInfo + deployPortInfo) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="flex items-center gap-1.5 shrink-0 ml-2">' + badges + '</div>' +
          '</div>' +
          deployControlsHtml;
        
        // 点击卡片空白区域切换项目并关闭弹窗
        card.addEventListener('click', function(e) {
          if (e.target.closest('button') || e.target.closest('a')) return;
          closeDeployModal();
          switchProject(project.id);
        });
        
        container.appendChild(card);
      });
    }
    async function startProject(projectId) {
      try {
        showToast(`正在启动 ${projectId}...`, 'info');
        const res = await fetch(`${API_BASE}/api/deploy/${projectId}/start`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          showToast(data.message, 'success');
          setTimeout(loadDeploymentStatus, 2000);
        } else {
          showToast(data.error || '启动失败', 'error');
        }
      } catch (err) {
        showToast('启动失败: ' + err.message, 'error');
      }
    }
    async function stopProject(projectId) {
      if (!confirm(`确定要停止 ${projectId} 吗？`)) return;
      
      try {
        showToast(`正在停止 ${projectId}...`, 'info');
        const res = await fetch(`${API_BASE}/api/deploy/${projectId}/stop`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          showToast(data.message, 'success');
          setTimeout(loadDeploymentStatus, 1000);
        } else {
          showToast(data.error || '停止失败', 'error');
        }
      } catch (err) {
        showToast('停止失败: ' + err.message, 'error');
      }
    }
    async function editProjectPort(projectId, currentPort) {
      const newPort = prompt(`修改 ${projectId} 的端口 (当前: ${currentPort}):`, currentPort);
      if (!newPort || newPort === String(currentPort)) return;
      
      const portNum = parseInt(newPort);
      if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        showToast('无效的端口号 (1024-65535)', 'error');
        return;
      }
      
      try {
        showToast('正在更新端口...', 'info');
        const res = await fetch(`${API_BASE}/api/deploy/${projectId}/update-port`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: portNum })
        });
        const data = await res.json();
        
        if (data.success) {
          showToast(`端口已更新: ${data.old_port} -> ${data.new_port}`, 'success');
          loadDeploymentStatus();
        } else {
          showToast(data.error || '更新失败', 'error');
        }
      } catch (err) {
        showToast('更新失败: ' + err.message, 'error');
      }
    }
    async function generateNginxConfig() {
      try {
        showToast('正在生成 Nginx 配置...', 'info');
        const res = await fetch(`${API_BASE}/api/nginx/generate-config`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          showToast('Nginx 配置已生成', 'success');
          loadDeploymentStatus();
        } else {
          showToast(data.error || '生成失败', 'error');
        }
      } catch (err) {
        showToast('生成失败: ' + err.message, 'error');
      }
    }
    async function applyNginxConfig() {
      if (!confirm('确定要应用 Nginx 配置并重载服务吗？')) return;
      
      try {
        showToast('正在应用 Nginx 配置...', 'info');
        const res = await fetch(`${API_BASE}/api/nginx/apply`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          showToast('Nginx 配置已应用', 'success');
          loadDeploymentStatus();
        } else {
          showToast(`${data.error || '应用失败'} (${data.step})`, 'error');
        }
      } catch (err) {
        showToast('应用失败: ' + err.message, 'error');
      }
    }
