    let term = null;
    let fitAddon = null;
    let terminalOffset = 0;
    function initXterm() {
      if (term) {
        try { term.dispose(); } catch {}
      }
      
      term = new Terminal({
        disableStdin: authState.enabled && !authState.authenticated,
        cursorBlink: true,
        convertEol: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e5e7eb',
          cursor: '#00d4ff',
          selectionBackground: '#00d4ff33',
          black: '#000000',
          red: '#ef4444',
          green: '#10b981',
          yellow: '#f59e0b',
          blue: '#3b82f6',
          magenta: '#8b5cf6',
          cyan: '#06b6d4',
          white: '#e5e7eb',
          brightBlack: '#374151',
          brightRed: '#f87171',
          brightGreen: '#34d399',
          brightYellow: '#fbbf24',
          brightBlue: '#60a5fa',
          brightMagenta: '#a78bfa',
          brightCyan: '#22d3ee',
          brightWhite: '#f9fafb'
        },
        scrollback: 10000,
        cols: 120,
        rows: 24
      });
      
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      
      const container = document.getElementById('terminal-container');
      container.innerHTML = '';
      term.open(container);
      fitAddon.fit();
      
      // 初始化后立即同步真实尺寸给后端，避免前后端列宽不一致导致流式输出折行错乱
      if (currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
        devmanSocket.send(JSON.stringify({
          type: 'terminal_resize',
          project_id: currentProject,
          cols: term.cols,
          rows: term.rows
        }));
      }
      
      // 键盘输入处理
      term.onData((data) => {
        if (currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
          devmanSocket.send(JSON.stringify({
            type: 'terminal_input',
            project_id: currentProject,
            data: data
          }));
        }
      });
      
      // 窗口大小变化时自适应，并通知后端调整 PTY 尺寸
      const notifyResize = () => {
        if (!fitAddon) return;
        fitAddon.fit();
        if (term && currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
          devmanSocket.send(JSON.stringify({
            type: 'terminal_resize',
            project_id: currentProject,
            cols: term.cols,
            rows: term.rows
          }));
        }
      };
      window.addEventListener('resize', notifyResize);
    }
    function clearXterm() {
      if (term) {
        term.clear();
        // 注意：clear 只是清屏，不应该重置 offset
        // 否则会导致后续订阅时重复接收已显示的内容
      }
    }
    function restartXterm() {
      terminalOffset = 0;
      initXterm();
      // 重新订阅终端，从 offset=0 获取完整历史
      if (currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
        devmanSocket.send(JSON.stringify({
          type: 'subscribe_terminal',
          project_id: currentProject,
          offset: 0
        }));
        console.log(`[restartXterm] 重新订阅终端: ${currentProject}, offset: 0`);
      }
    }
    function sendCtrlC() {
      if (!requireWriteAccess('发送终端控制信号需要开发权限')) return;
      if (currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
        devmanSocket.send(JSON.stringify({
          type: 'terminal_input',
          project_id: currentProject,
          data: '\u0003'  // Ctrl+C
        }));
      }
    }
    function sendCtrlD() {
      if (!requireWriteAccess('发送终端控制信号需要开发权限')) return;
      if (currentProject && devmanSocket && devmanSocket.readyState === WebSocket.OPEN) {
        devmanSocket.send(JSON.stringify({
          type: 'terminal_input',
          project_id: currentProject,
          data: '\u0004'  // Ctrl+D (EOF)
        }));
      }
    }
    async function forceStopTerminalTask() {
      if (!currentProject) {
        showToast('请先选择一个项目', 'warning');
        return;
      }
      if (!requireWriteAccess('强制停止任务需要开发权限')) return;
      
      if (!confirm('确定要强制停止当前任务吗？\n\n这将：\n1. 发送中断信号到运行中的进程\n2. 重置任务状态为待处理\n3. 清理执行状态')) {
        return;
      }
      
      // 1. 先发送 Ctrl+C
      sendCtrlC();
      
      // 2. 调用 executor/stop 杀死进程
      try {
        await fetch(`${API_BASE}/api/executor/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: currentProject })
        });
      } catch (e) {
        console.log('[forceStop] executor/stop 失败:', e.message);
      }
      
      // 3. 调用 queue/stop 重置任务状态
      try {
        const res = await fetch(`${API_BASE}/api/queue/${currentProject}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: '用户在终端强制停止' })
        });
        const data = await res.json();
        
        if (data.success) {
          showToast('任务已强制停止', 'success');
        } else {
          showToast(data.error || '停止任务失败', 'error');
        }
      } catch (err) {
        showToast('停止失败: ' + err.message, 'error');
      }
      
      // 4. 刷新数据
      setTimeout(() => refreshAllData(), 500);
    }
    async function fetchTerminalLogs() {
      // 更新终端状态指示器和任务信息
      try {
        const [terminalRes, queueRes] = await Promise.all([
          fetch(`${API_BASE}/api/terminal/${currentProject}`),
          fetch(`${API_BASE}/api/queue`)
        ]);
        
        const terminalData = await terminalRes.json();
        const queueData = await queueRes.json();
        
        const statusEl = document.getElementById('terminal-status');
        const stopBtn = document.getElementById('terminal-stop-btn');
        
        // 获取当前项目的执行中任务
        const executingTask = queueData.executing_tasks?.find(t => t.project_id === currentProject);
        let taskName = '';
        if (executingTask && executingTask.feature_name) {
          taskName = executingTask.feature_name.substring(0, 15) + (executingTask.feature_name.length > 15 ? '...' : '');
        }
        
        if (terminalData.active || executingTask) {
          const statusText = taskName ? `执行: ${taskName}` : '执行中';
          statusEl.textContent = statusText;
          statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-accent/20 text-accent animate-pulse';
          if (stopBtn) stopBtn.classList.remove('hidden');
        } else if (terminalData.task_id) {
          // 有历史任务但已结束：显示空闲，隐藏停止按钮
          const session = terminalData;
          statusEl.textContent = '空闲 (有历史记录)';
          statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-gray-700 text-gray-400';
          if (stopBtn) stopBtn.classList.add('hidden');
        } else {
          statusEl.textContent = '等待中';
          statusEl.className = 'ml-2 px-2 py-0.5 text-[10px] rounded bg-gray-700 text-gray-400';
          if (stopBtn) stopBtn.classList.add('hidden');
        }
      } catch (err) {
        // 静默失败
      }
    }
    // ========== 终端输入处理 ==========
    function handleTerminalInput(event) {
      if (event.key === 'Enter') {
        if (!requireWriteAccess('终端输入需要开发权限')) return;
        const input = document.getElementById('terminal-input');
        const command = input.value.trim();
        
        if (!command) return;
        
        if (!currentProject) {
          showToast('请先选择项目', 'warning');
          return;
        }
        
        if (!devmanSocket || devmanSocket.readyState !== WebSocket.OPEN) {
          showToast('WebSocket 未连接', 'error');
          return;
        }
        
        // 发送命令到终端（通过 xterm 的键盘输入处理，保持一致性）
        console.log(`[终端输入] 发送命令到 ${currentProject}: ${command}`);
        if (term) {
          // 使用 term.paste 来模拟输入，这样可以统一走 term.onData 的处理
          term.paste(command + '\r');
        } else {
          // 备用方案：直接发送
          devmanSocket.send(JSON.stringify({
            type: 'terminal_input',
            project_id: currentProject,
            data: command + '\r'
          }));
        }
        
        // 清空输入框
        input.value = '';
      }
    }
