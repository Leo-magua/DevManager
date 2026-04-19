    let currentProject = null;
    let projects = [];
    let selectedFeature = null;
    let featureModalMode = 'start';
    let autoRefreshInterval = null;
    let currentProjectDefaultTool = 'kimi';
    document.addEventListener('DOMContentLoaded', async () => {
      await refreshAuthStatus({ silent: true });
      loadProjects();
      connectWebSocket();
      
      // ESC 键快捷停止（当终端执行中时）
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const stopBtn = document.getElementById('terminal-stop-btn');
          // 只有当停止按钮可见（即有任务在执行）时才响应
          if (stopBtn && !stopBtn.classList.contains('hidden')) {
            e.preventDefault();
            forceStopTerminalTask();
          }
        }
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
      } else if (currentProject) {
        showDashboard();
        refreshAllData();
        fetchTerminalLogs();
      }
    });
