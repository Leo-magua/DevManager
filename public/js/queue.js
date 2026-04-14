    // 切换暂停状态
    async function togglePause() {
      try {
        const res = await fetch(`${API_BASE}/api/queue/pause/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        updatePauseUI(data.paused);
        
        if (data.paused) {
          showToast('任务队列已暂停', 'warning');
        } else {
          showToast('任务队列已恢复', 'success');
          // 恢复后，如果有当前项目且有待执行任务，自动触发执行
          if (currentProject) {
            // 延迟1秒确保后端状态已完全切换
            setTimeout(() => {
              startNextQueuedTask();
            }, 1000);
          }
        }
      } catch (err) {
        showToast('操作失败: ' + err.message, 'error');
      }
    }
    // 更新暂停按钮 UI
    function updatePauseUI(paused) {
      const indicator = document.getElementById('pause-indicator');
      const btn = document.getElementById('pause-btn');
      const icon = document.getElementById('pause-icon');
      const text = document.getElementById('pause-text');
      
      if (paused) {
        indicator.classList.remove('hidden');
        btn.classList.add('bg-red-500/20', 'text-red-400', 'border-red-500/30');
        btn.classList.remove('bg-dark-700', 'text-gray-300', 'border-dark-500');
        text.textContent = '继续';
        // 切换为播放图标
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
      } else {
        indicator.classList.add('hidden');
        btn.classList.remove('bg-red-500/20', 'text-red-400', 'border-red-500/30');
        btn.classList.add('bg-dark-700', 'text-gray-300', 'border-dark-500');
        text.textContent = '暂停';
        // 切换为暂停图标
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />';
      }
    }
    async function startNextQueuedTask() {
      if (!currentProject) return;
      
      try {
        // 先检查当前项目状态
        const statusRes = await fetch(`${API_BASE}/api/queue/${currentProject}`);
        const statusData = await statusRes.json();
        
        // 如果没有执行中的任务且有排队任务
        if (!statusData.executing && statusData.queued_count > 0) {
          console.log('[继续] 开始认领并执行队列最上方任务');
          
          // 直接调用认领任务API
          const claimRes = await fetch(`${API_BASE}/api/queue/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              project_id: currentProject,
              agent_id: 'manual-resume',
              agent_name: 'User Resume'
            })
          });
          
          const claimData = await claimRes.json();
          if (claimData.success && claimData.task) {
            showToast(`开始执行: ${claimData.task.feature_name}`, 'success');
            refreshAllData();
          } else if (claimData.error) {
            showToast(claimData.error, 'warning');
          }
        } else if (statusData.executing) {
          console.log('[继续] 已有任务在执行中');
        } else {
          console.log('[继续] 队列为空');
        }
      } catch (err) {
        console.error('[继续] 触发执行失败:', err);
        showToast('继续执行失败: ' + err.message, 'error');
      }
    }
    async function stopCurrentTask() {
      if (!currentProject) {
        showToast('请先选择一个项目', 'warning');
        return;
      }
      
      if (!confirm('确定要停止当前项目的开发任务吗？\n\n⚠️ 这会终止正在运行的 Kimi Agent 进程')) {
        return;
      }
      
      try {
        const res = await fetch(`${API_BASE}/api/queue/${currentProject}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: '用户手动停止' })
        });
        const data = await res.json();
        
        if (data.success) {
          showToast('任务已停止', 'success');
          // 刷新数据
          setTimeout(() => refreshAllData(), 500);
        } else {
          showToast(data.error || '停止失败', 'error');
        }
      } catch (err) {
        showToast('停止失败: ' + err.message, 'error');
      }
    }
    async function pauseTopTask(event) {
      event.stopPropagation();
      if (!currentProject) return;

      if (!confirm('确定要暂停当前任务吗？\n\n任务将保留在开发队列中，待你点击「继续」后自动恢复执行。')) return;

      try {
        const res = await fetch(`${API_BASE}/api/queue/${currentProject}/pause-task`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || '任务已暂停', 'success');
          refreshAllData();
        } else {
          showToast(data.error || '暂停失败', 'error');
        }
      } catch (err) {
        showToast('暂停失败: ' + err.message, 'error');
      }
    }
    async function deleteFeature(featureId, event) {
      event.stopPropagation();
      if (!currentProject) return;
      
      if (!confirm('确定要删除这个任务吗？此操作不可恢复。')) return;
      
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}`, {
          method: 'DELETE'
        });
        
        const data = await res.json();
        if (data.success) {
          showToast('任务已删除', 'success');
          refreshAllData();
        } else {
          showToast(data.error || '删除失败', 'error');
        }
      } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
      }
    }
