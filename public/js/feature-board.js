    let draggedCard = null;
    let draggedFeature = null;
    let draggedCardIsQueued = false; // 标记拖拽的是否是排队中任务
    function renderFeatureBoard(features, executingTask) {
      const cols = { pending: document.getElementById('col-pending'), progress: document.getElementById('col-progress'), completed: document.getElementById('col-completed') };
      const counts = { pending: document.getElementById('count-pending'), progress: document.getElementById('count-progress'), completed: document.getElementById('count-completed') };

      const list = [...(features || [])];
      const execId = executingTask && executingTask.feature_id;
      if (execId) {
        const idx = list.findIndex(f => f.id === execId);
        if (idx === -1) {
          list.push({
            id: executingTask.feature_id,
            name: executingTask.feature_name,
            description: executingTask.feature_desc || '',
            status: 'In_Progress',
            category: executingTask.category || '执行中',
            toolType: executingTask.tool_type || executingTask.toolType || ''
          });
        } else {
          list[idx] = { ...list[idx], status: 'In_Progress' };
        }
      }

      Object.values(cols).forEach(c => { if (c) c.innerHTML = ''; });

      const pendingItems = list.filter(f => (f.status || 'Pending') === 'Pending');
      const queuedInOrder = list.filter(f => f.status === 'Queued' && f.id !== execId);
      const completedItems = list.filter(f => f.status === 'Completed');
      let runner = null;
      if (execId) {
        runner = list.find(f => f.id === execId) || null;
      }

      function mountCard(targetCol, f, opts) {
        const isRunner = !!opts.isRunner;
        const isQueued = !isRunner && f.status === 'Queued';
        const status = isRunner ? 'In_Progress' : (f.status || 'Pending');
        const sInfo = statusMap[status] || statusMap.Pending;

        const card = document.createElement('div');
        card.dataset.featureId = f.id;
        const borderRun = isRunner ? 'border-red-500/70 bg-red-950/25 shadow-[0_0_0_1px_rgba(239,68,68,0.35)]' : 'border-dark-600 hover:border-dark-500';
        // 排队中任务可拖动（用于排序），待处理也可拖动（用于跨列），执行中不可拖动
        const isDraggable = !isRunner;
        card.className = `rounded-lg p-2.5 border transition-all relative ${borderRun} ${isRunner ? 'cursor-not-allowed' : 'bg-dark-700' + (isDraggable ? ' cursor-move' : '')}`;

        card.draggable = isDraggable;

        const dotClass = isRunner ? 'bg-violet-500 animate-pulse' : (status === 'Pending' ? 'bg-amber-400' : status === 'Queued' ? 'bg-blue-400' : 'bg-emerald-400');
        const dotTitle = isRunner ? '执行中（已锁定）' : sInfo.label;

        // 圆形按钮 - 更小的尺寸
        let sideBtn = '';
        if (isRunner) {
          // 执行中：仅显示暂停按钮（紫色），卡片完全锁定
          sideBtn = `
            <button type="button" onclick="pauseTopTask(event)"
              class="w-7 h-7 rounded-full bg-violet-500/20 text-violet-300 hover:bg-violet-500/35 border border-violet-500/35 flex items-center justify-center transition-colors"
              title="暂停任务">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </button>`;
        } else if (isQueued) {
          // 排队中：可通过拖动排序，不需要按钮
          sideBtn = '';
        } else if (status === 'Pending' && !isRunner) {
          sideBtn = `
            <button type="button" onclick="quickStartTask('${f.id}')"
              class="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/35 border border-emerald-500/35 flex items-center justify-center transition-colors"
              title="执行开发">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>`;
        } else if (status === 'Completed' && !isRunner) {
          sideBtn = `
            <button type="button" onclick="deleteFeature('${f.id}', event)"
              class="w-7 h-7 rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/30 border border-red-500/25 flex items-center justify-center transition-colors"
              title="删除">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>`;
        }

        const runnerBadge = isRunner
          ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/30 text-violet-200 border border-violet-500/40">执行中</span>'
          : (isQueued ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40 font-medium">⏳ 排队</span>' : '');
        const toolBadge = isRunner && f.toolType
          ? (f.toolType === 'cursor'
              ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">Cursor</span>'
              : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40">Kimi</span>')
          : '';

        // 简化的卡片布局 - 状态点在最右边
        card.innerHTML = `
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] text-accent font-mono">${f.id}</span>
                ${runnerBadge}
                ${toolBadge}
              </div>
              <div class="text-sm text-white font-medium truncate mt-0.5" title="${escapeHtml(f.name || '')}">${escapeHtml(f.name || '')}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${sideBtn}
              <span class="w-2 h-2 rounded-full ${dotClass}" title="${dotTitle}"></span>
            </div>
          </div>
        `;

        const payload = { ...f, __isRunner: isRunner };
        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          if (isRunner) return; // 执行中卡片不开弹窗
          showFeatureModal(payload);
        });

        if (!isRunner) {
          card.addEventListener('dragstart', (e) => {
            draggedCard = card;
            draggedFeature = f;
            draggedCardIsQueued = isQueued; // 标记是否是排队中任务
            card.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
          });
          card.addEventListener('dragend', () => {
            card.style.opacity = '1';
            draggedCard = null;
            draggedFeature = null;
            draggedCardIsQueued = false;
            document.querySelectorAll('[id^="col-"]').forEach(col => {
              col.classList.remove('border-accent', 'bg-accent/5');
            });
          });
        }

        targetCol.appendChild(card);
      }

      pendingItems.forEach(f => mountCard(cols.pending, f, { isRunner: false }));
      if (runner) {
        mountCard(cols.progress, runner, { isRunner: true });
      }
      queuedInOrder.forEach(f => mountCard(cols.progress, f, { isRunner: false }));
      completedItems.forEach(f => mountCard(cols.completed, f, { isRunner: false }));

      const boardEl = document.getElementById('feature-board');
      if (boardEl && !boardEl.dataset.dropBound) {
        boardEl.dataset.dropBound = '1';
        Object.entries(cols).forEach(([status, col]) => {
          if (!col) return;
          col.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            col.classList.add('border-accent', 'bg-accent/5');
          });
          col.addEventListener('dragleave', () => {
            col.classList.remove('border-accent', 'bg-accent/5');
          });
          col.addEventListener('drop', (e) => {
            e.preventDefault();
            col.classList.remove('border-accent', 'bg-accent/5');
            if (!draggedFeature) return;
            
            const newStatus = status === 'pending' ? 'Pending' : status === 'progress' ? 'Queued' : 'Completed';
            const cur = draggedFeature.status || 'Pending';
            
            // 如果是排队中任务在开发队列列内拖动，处理排序
            if (draggedCardIsQueued && status === 'progress' && cur === 'Queued') {
              handleQueuedReorder(e, col);
              return;
            }
            
            // 排队中任务拖到待处理列 -> 移出队列
            if (draggedCardIsQueued && status === 'pending' && cur === 'Queued') {
              if (confirm('确定要将此任务移出开发队列？')) {
                updateFeatureStatus(draggedFeature.id, 'Pending');
              }
              return;
            }
            
            // 跨列状态变更（其他情况）
            if (newStatus !== cur) {
              updateFeatureStatus(draggedFeature.id, newStatus);
            }
          });
        });
      }

      counts.pending.textContent = pendingItems.length;
      counts.progress.textContent = queuedInOrder.length + (runner ? 1 : 0);
      counts.completed.textContent = completedItems.length;
    }
    function renderGlobalQueueStatus(globalQueue, projectQueue, featureList = []) {
      const list = [...(featureList || [])];
      const live = projectQueue.executing;
      const execId = live && live.feature_id;

      if (execId) {
        const idx = list.findIndex(f => f.id === execId);
        if (idx === -1) {
          list.push({
            id: live.feature_id,
            name: live.feature_name,
            status: 'In_Progress'
          });
        } else {
          list[idx] = { ...list[idx], status: 'In_Progress', toolType: live.tool_type || live.toolType || list[idx].toolType || '' };
        }
      }

      let nPending = 0;
      let nQueued = 0;
      let nCompleted = 0;
      for (const f of list) {
        const st = f.status || 'Pending';
        if (st === 'Completed') nCompleted++;
        else if (st === 'Queued') nQueued++;
        else if (st === 'In_Progress') {
          if (execId && f.id === execId) continue;
          nQueued++;
        } else if (st === 'Pending' || !f.status) nPending++;
      }
      const devQueueTotal = nQueued + (execId ? 1 : 0);

      document.getElementById('queue-pending').textContent = nPending;
      document.getElementById('queue-active').textContent = devQueueTotal;
      document.getElementById('queue-completed').textContent = nCompleted;
      
      // 如果有开发中的任务，显示提示
      const activeLabel = document.getElementById('queue-active');
      if (live && live.feature_name) {
        const shortName = live.feature_name.substring(0, 20) + (live.feature_name.length > 20 ? '...' : '');
        activeLabel.title = `当前任务: ${shortName}`;
        activeLabel.classList.add('cursor-help', 'border-b', 'border-dashed', 'border-blue-400');
      } else {
        activeLabel.title = '';
        activeLabel.classList.remove('cursor-help', 'border-b', 'border-dashed', 'border-blue-400');
      }
      
      // 更新暂停状态显示（使用全局状态）
      updatePauseUI(globalQueue.paused);
      
      // 显示/隐藏停止任务按钮
      const stopBtn = document.getElementById('stop-task-btn');
      const hasActiveTask = live && typeof live === 'object';
      if (hasActiveTask && currentProject) {
        stopBtn.classList.remove('hidden');
      } else {
        stopBtn.classList.add('hidden');
      }
    }
    async function quickStartTask(featureId) {
      if (!currentProject) return;
      showToast('正在启动任务...', 'info');
      await startDevelopment(featureId);
    }
    async function startDevelopment(featureId, options = {}) {
      const { saveContent = false, name, description } = options;
      
      if (saveContent) {
        try {
          const putRes = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
          });
          const putData = await putRes.json();
          if (!putData.success) {
            showToast(putData.error || '保存需求失败', 'error');
            return false;
          }
        } catch (err) {
          showToast('保存需求失败: ' + err.message, 'error');
          return false;
        }
      }
      
      try {
        const toolType = document.querySelector('input[name="modal_tool_type"]:checked')?.value || 'kimi';
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_type: toolType })
        });
        const data = await res.json();
        if (data.success) {
          showToast('任务已加入开发队列', 'success');
          refreshAllData();
          return true;
        } else {
          showToast(data.error || '启动失败', 'error');
          return false;
        }
      } catch (err) {
        showToast('启动失败: ' + err.message, 'error');
        return false;
      }
    }
    async function moveFeature(featureId, direction, event) {
      event.stopPropagation();
      if (!currentProject) return;
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}/reorder`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction })
        });
        const data = await res.json();
        if (data.success && !data.no_change) {
          refreshAllData();
        } else if (!data.success) {
          showToast(data.error || '调整失败', 'error');
        }
      } catch (err) {
        showToast('调整失败: ' + err.message, 'error');
      }
    }
    async function handleQueuedReorder(e, col) {
      if (!draggedFeature || !currentProject) return;
      
      // 获取鼠标位置下的所有卡片
      const afterElement = getDragAfterElement(col, e.clientY);
      
      // 获取开发队列中所有排队中任务的顺序
      const cards = [...col.querySelectorAll('[data-feature-id]')];
      const queuedCards = cards.filter(card => {
        const fid = card.dataset.featureId;
        // 排除执行中的任务（置顶任务）
        return fid !== draggedFeature.id && !card.querySelector('.bg-violet-500');
      });
      
      // 找到目标位置
      let targetIndex = queuedCards.length;
      if (afterElement) {
        targetIndex = queuedCards.indexOf(afterElement);
        if (targetIndex === -1) targetIndex = queuedCards.length;
      }
      
      // 找到当前 draggedFeature 在队列中的位置
      const currentList = [...queuedCards];
      const currentIndex = currentList.findIndex(card => card.dataset.featureId === draggedFeature.id);
      
      // 计算需要移动的方向和步数
      if (currentIndex !== -1 && targetIndex !== currentIndex) {
        const direction = targetIndex < currentIndex ? 'up' : 'down';
        const steps = Math.abs(targetIndex - currentIndex);
        
        // 调用API逐步移动
        try {
          for (let i = 0; i < steps; i++) {
            const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${draggedFeature.id}/reorder`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ direction })
            });
            const data = await res.json();
            if (!data.success) break;
          }
          refreshAllData();
        } catch (err) {
          showToast('排序调整失败: ' + err.message, 'error');
        }
      }
    }
    function getDragAfterElement(container, y) {
      const draggableElements = [...container.querySelectorAll('[draggable="true"]')];
      
      return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset: offset, element: child };
        } else {
          return closest;
        }
      }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
    async function updateFeatureStatus(featureId, newStatus) {
      if (!currentProject) return;
      
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, auto_start: true })
        });
        
        const data = await res.json();
        if (data.success) {
          const message = data.task_started 
            ? `状态已更新，任务已开始执行` 
            : `状态已更新为: ${statusMap[newStatus]?.label || newStatus}`;
          showToast(message, 'success');
          refreshAllData();
        } else {
          showToast(data.error || '更新失败', 'error');
        }
      } catch (err) {
        showToast('更新失败: ' + err.message, 'error');
      }
    }
    async function bulkBoardAction(action) {
      if (!currentProject) {
        showToast('请先选择项目', 'warning');
        return;
      }
      const hints = {
        pending_to_progress: '将所有「待处理」按列表顺序加入开发队列，并自动启动队首任务（若当前无执行中且未暂停）。',
        progress_to_pending: '清空开发队列（排队+执行中）并全部退回「待处理」，并停止当前运行任务（若存在）。',
        pause_in_progress: '将全局队列设为暂停，并停止当前项目正在运行的 Agent（若存在）。'
      };
      if (!confirm((hints[action] || '继续') + '\n\n确定执行？')) return;
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/bulk-actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || '操作成功', 'success');
          if (action === 'pause_in_progress') {
            try {
              const q = await fetch(`${API_BASE}/api/queue`);
              const qd = await q.json();
              updatePauseUI(!!qd.paused);
            } catch (_) {
              updatePauseUI(true);
            }
          }
          // 强制刷新：pending_to_progress 后所有 Queued 任务必须立刻显示在队列列中
          isRefreshing = false;
          refreshAllData();
        } else {
          showToast(data.error || '操作失败', 'error');
        }
      } catch (err) {
        showToast('操作失败: ' + err.message, 'error');
      }
    }
