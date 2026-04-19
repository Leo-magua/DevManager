    async function loadProjects() {
      try {
        const res = await fetch(`${API_BASE}/api/projects`);
        const data = await res.json();
        projects = data.projects || [];
        // 项目列表已通过项目列表弹窗动态加载
      } catch (err) {
        showToast('加载项目列表失败', 'error');
      }
    }
    async function openProjectListModal() {
      document.getElementById('project-list-modal').classList.remove('hidden');
      await renderProjectList();
    }
    function closeProjectListModal() {
      document.getElementById('project-list-modal').classList.add('hidden');
    }
    async function renderProjectList() {
      const container = document.getElementById('project-list-content');
      container.innerHTML = '<div class="text-sm text-gray-500 italic">加载中...</div>';
      
      try {
        // 获取项目列表
        const res = await fetch(`${API_BASE}/api/projects`);
        const data = await res.json();
        const projectList = data.projects || [];
        
        if (projectList.length === 0) {
          container.innerHTML = '<div class="text-sm text-gray-500 text-center py-8">暂无项目，请先扫描项目目录</div>';
          return;
        }
        
        container.innerHTML = '';
        projectList.forEach(p => {
          const isCurrent = p.id === currentProject;
          
          const item = document.createElement('div');
          item.className = `p-3 rounded-lg border cursor-pointer transition-all ${isCurrent ? 'bg-accent/10 border-accent/50' : 'bg-dark-800 border-dark-600 hover:border-dark-500'}`;
          
          const statusDot = isCurrent ? '<span class="w-2 h-2 rounded-full bg-accent"></span>' : '';
          
          item.innerHTML = `
            <div class="flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  ${statusDot}
                  <span class="text-sm font-medium text-white truncate">${p.name}</span>
                  ${p.active === false ? '<span class="text-[10px] text-gray-500">(停用)</span>' : ''}
                </div>
                <div class="text-xs text-gray-500 mt-0.5">${(p.tech_stack || []).join(' · ') || '未识别'}</div>
              </div>
            </div>
          `;
          
          // 点击空白处切换项目
          item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            closeProjectListModal();
            switchProject(p.id);
          });
          
          container.appendChild(item);
        });
      } catch (err) {
        container.innerHTML = `<div class="text-sm text-red-400 text-center py-8">加载失败: ${err.message}</div>`;
      }
    }
    async function switchProject(projectId) {
      if (!projectId) {
        hideDashboard();
        document.getElementById('current-project-name').textContent = '选择项目...';
        return;
      }
      
      // 取消之前的终端订阅
      if (devmanSocket && devmanSocket.readyState === WebSocket.OPEN && currentProject) {
        devmanSocket.send(JSON.stringify({
          type: 'unsubscribe_terminal'
        }));
      }
      
      currentProject = projectId;
      terminalOffset = 0;
      
      // 更新顶部项目名称显示
      const project = projects.find(p => p.id === projectId);
      if (project) {
        document.getElementById('current-project-name').textContent = project.name;
      }
      
      // 初始化终端（如果尚未初始化）
      if (!term) {
        initXterm();
      } else {
        // 清空终端，准备显示新项目的内容
        term.reset();
      }
      term.write('\x1b[90m[正在加载终端历史...]\x1b[0m\r\n');
      
      // 订阅新项目的终端（从 offset=0 开始获取完整历史）
      if (devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
        devmanSocket.send(JSON.stringify({
          type: 'subscribe_terminal',
          project_id: projectId,
          offset: 0
        }));
        console.log(`[switchProject] 订阅终端: ${projectId}, offset: 0`);
      }
      
      await refreshAllData();
      showDashboard();
    }
    function showDashboard() {
      document.getElementById('empty-state').classList.add('hidden');
      document.getElementById('project-header').classList.remove('hidden');
      document.getElementById('feature-board').classList.remove('hidden');
      document.getElementById('terminal-section').classList.remove('hidden');
      document.getElementById('bottom-sections').classList.remove('hidden');
      // deployment-manager 改为弹窗形式，不在主页面显示
      
      // 初始化 xterm（若尚未初始化）
      if (!term) {
        initXterm();
      }
      
      // 注意：终端订阅现在在 switchProject() 或 WebSocket onopen 中统一处理
      // 避免重复订阅导致内容重复显示
      
      if (autoRefreshInterval) clearInterval(autoRefreshInterval);
      autoRefreshInterval = setInterval(() => {
        refreshAllData();
        fetchTerminalLogs();
      }, 3000);
    }
    function hideDashboard() {
      document.getElementById('empty-state').classList.remove('hidden');
      document.getElementById('project-header').classList.add('hidden');
      document.getElementById('feature-board').classList.add('hidden');
      document.getElementById('terminal-section').classList.add('hidden');
      document.getElementById('bottom-sections').classList.add('hidden');
      document.getElementById('current-project-name').textContent = '选择项目...';
      if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    }
    let isRefreshing = false;
    async function refreshAllData() {
      if (!currentProject || isRefreshing) return;
      isRefreshing = true;
      
      try {
        // 并行获取全局队列和项目数据
        const [globalQueueRes, projectRes] = await Promise.all([
          fetch(`${API_BASE}/api/queue`),
          fetch(`${API_BASE}/api/projects/${currentProject}/dashboard`)
        ]);
        
        const globalQueue = await globalQueueRes.json();
        const projectData = await projectRes.json();

        if (projectData.error) {
          throw new Error(projectData.error);
        }

        // 顶部队列数字显示全局数据
        renderGlobalQueueStatus(globalQueue, projectData.queue || {}, projectData.feature_list || []);
        renderProjectData(projectData);
        updateTime();
        setConnection(true);
      } catch (err) {
        setConnection(false);
        showToast('刷新失败: ' + err.message, 'error');
      } finally {
        isRefreshing = false;
      }
    }
    function renderProjectData(data) {
      // 项目信息
      document.getElementById('project-name').textContent = data.project.name;
      document.getElementById('project-desc').textContent = data.project.description || '暂无描述';
      document.getElementById('project-tech').textContent = (data.project.tech_stack || []).join(' · ') || '';
      currentProjectDefaultTool = data.project.default_tool_type || 'kimi';
      renderProjectDefaultToolSelector(currentProjectDefaultTool);

      // 获取执行中的任务
      const live = data.queue && data.queue.executing;

      renderDeployServices(data.deploy_services || []);

      // 看板（队列里正在跑但不在 feature_list 的任务也显示在「开发中」）
      renderFeatureBoard(data.feature_list || [], live || null);
      // 日志
      renderChangelog(data.changelog || []);
    }
    function renderProjectDefaultToolSelector(toolType) {
      document.querySelectorAll('input[name="project_default_tool_type"]').forEach(input => {
        input.checked = input.value === toolType;
      });
      const hint = document.getElementById('project-default-tool-hint');
      if (hint) {
        const label = toolType.charAt(0).toUpperCase() + toolType.slice(1);
        hint.textContent = `未指定需求卡片工具时，任务会使用 ${label} 执行。`;
      }
    }
    async function updateProjectDefaultTool(toolType) {
      if (!currentProject) return;
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/default-tool`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_type: toolType })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error || `请求失败 (${res.status})`);
        }
        if (!data.success) {
          throw new Error(data.error || '保存失败');
        }
        currentProjectDefaultTool = data.project.default_tool_type || toolType;
        renderProjectDefaultToolSelector(currentProjectDefaultTool);
        showToast(`默认执行工具已切换为 ${currentProjectDefaultTool}`, 'success');
      } catch (err) {
        renderProjectDefaultToolSelector(currentProjectDefaultTool || 'kimi');
        showToast('默认执行工具保存失败: ' + err.message, 'error');
      }
    }
    document.addEventListener('change', (e) => {
      if (e.target && e.target.name === 'project_default_tool_type') {
        updateProjectDefaultTool(e.target.value);
      }
    });
    function renderChangelog(logs) {
      const container = document.getElementById('changelog-list');
      container.innerHTML = '';

      logs.slice(0, 20).forEach(log => {
        const typeColors = {
          system: 'border-gray-600 bg-dark-700',
          backlog: 'border-accent/30 bg-accent/5',
          status_change: 'border-blue-500/30 bg-blue-500/5',
          error: 'border-red-500/30 bg-red-500/5',
          nlp_create: 'border-purple-500/30 bg-purple-500/5'
        };

        const div = document.createElement('div');
        div.className = `p-3 rounded-lg border-l-2 ${typeColors[log.type] || typeColors.system}`;
        div.innerHTML = `
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-medium text-gray-300">${log.message}</span>
            <span class="text-[10px] text-gray-600">${new Date(log.timestamp).toLocaleTimeString()}</span>
          </div>
          ${log.details ? `<div class="text-xs text-gray-500">${log.details}</div>` : ''}
        `;
        container.appendChild(div);
      });
    }
