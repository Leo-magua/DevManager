    let devmanSocket = null;
    let wsThrottleTimer = null;
    let isFetchingLogs = false;
    function connectWebSocket() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}`;
      try {
        devmanSocket = new WebSocket(url);
        
        devmanSocket.onopen = () => {
          console.log('[WebSocket] 连接成功');
          // 重连后使用当前 offset 订阅，避免重复接收已显示的内容
          if (currentProject) {
            // 不重置终端，而是使用当前的 terminalOffset 继续接收新数据
            devmanSocket.send(JSON.stringify({
              type: 'subscribe_terminal',
              project_id: currentProject,
              offset: terminalOffset
            }));
            console.log(`[WebSocket] 订阅终端: ${currentProject}, offset: ${terminalOffset}`);
          }
        };
        
        devmanSocket.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const t = msg.type;
            
            // 终端数据 - 直接写入 xterm
            if (t === 'terminal_data' && msg.data) {
              if (term && msg.project_id === currentProject) {
                term.write(msg.data);
                // 更新 offset，用于断线重连后只获取新数据
                if (msg.offset !== undefined) {
                  terminalOffset = msg.offset;
                }
              }
              return;
            }
            
            // 终端退出：更新状态指示器（退出消息已由后端写入缓冲区）
            if (t === 'terminal_exit') {
              if (msg.project_id === currentProject) {
                const statusEl = document.getElementById('terminal-status');
                const stopBtn = document.getElementById('terminal-stop-btn');
                if (msg.data && msg.data.success) {
                  statusEl.textContent = '已完成';
                  statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400';
                } else {
                  statusEl.textContent = msg.data && msg.data.code !== undefined ? `退出码:${msg.data.code}` : '已结束';
                  statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400';
                }
                if (stopBtn) stopBtn.classList.add('hidden');
              }
              return;
            }
            
            // 终端错误（静默处理，shell 始终可用）
            if (t === 'terminal_error') {
              console.warn(`[终端错误] ${msg.project_id}: ${msg.error}`);
              return;
            }
            
            const refreshTypes = ['status', 'task_added', 'task_started', 'task_completed', 'task_failed', 'task_log', 'task_reset', 'task_stopped', 'pause_changed', 'features_bulk', 'feature_updated', 'feature_deleted', 'feature_created', 'features_batch_created'];
            if (refreshTypes.includes(t)) {
              if (wsThrottleTimer) clearTimeout(wsThrottleTimer);
              wsThrottleTimer = setTimeout(() => {
                if (currentProject) {
                  refreshAllData();
                  fetchTerminalLogs();
                }
              }, 400);
              
              if (t === 'task_started' && msg.data?.project_id === currentProject) {
                if (!term) initXterm();
                // 不清空终端：后端 init 已追加任务分隔符，重新订阅即可显示历史+新内容
                terminalOffset = 0;
                if (devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
                  devmanSocket.send(JSON.stringify({
                    type: 'subscribe_terminal',
                    project_id: currentProject,
                    offset: 0
                  }));
                }
                // 更新状态指示器
                const statusEl = document.getElementById('terminal-status');
                if (statusEl) {
                  const taskName = msg.data?.feature_name || msg.data?.task?.feature_name || '';
                  const shortName = taskName.length > 15 ? taskName.slice(0, 15) + '...' : taskName;
                  statusEl.textContent = shortName ? `执行: ${shortName}` : '执行中';
                  statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-accent/20 text-accent animate-pulse';
                }
                const stopBtn = document.getElementById('terminal-stop-btn');
                if (stopBtn) stopBtn.classList.remove('hidden');
              }
            }
          } catch (_) {}
        };
        
        devmanSocket.onclose = () => {
          setTimeout(connectWebSocket, 4000);
        };
      } catch (e) {
        console.warn('WebSocket 不可用，将仅使用轮询', e);
      }
    }
