    let currentInputMode = 'natural';
    let aiParsedTasks = [];
    function openAddFeatureModal() {
      if (!currentProject) {
        showToast('请先选择项目', 'error');
        return;
      }
      document.getElementById('add-feature-modal').classList.remove('hidden');
      // 重置表单
      document.getElementById('feature-title').value = '';
      document.getElementById('feature-desc').value = '';
      document.getElementById('feature-category').value = 'Feature';
      document.getElementById('ai-feature-input').value = '';
      document.getElementById('feature-auto-start').checked = false;
      document.getElementById('ai-parse-result').classList.add('hidden');
      aiParsedTasks = [];
      switchInputMode('natural');
    }
    function closeAddFeatureModal() {
      document.getElementById('add-feature-modal').classList.add('hidden');
    }
    function showFeatureModal(feature, opts = {}) {
      selectedFeature = feature;
      const readOnly = !!opts.readOnly || !!feature.__isRunner;
      const st = feature.status || 'Pending';
      const pending = st === 'Pending';
      featureModalMode = pending ? 'start' : 'edit';
      document.getElementById('modal-task-id').textContent = feature.id;
      document.getElementById('modal-task-title').value = feature.name || '';
      document.getElementById('modal-task-desc').value = feature.description || '';
      document.getElementById('modal-task-title').disabled = readOnly;
      document.getElementById('modal-task-desc').disabled = readOnly;
      const btnStart = document.getElementById('modal-btn-start');
      const btnSave = document.getElementById('modal-btn-save-only');
      const titleEl = document.getElementById('modal-title');
      const subEl = document.getElementById('modal-subtitle');
      if (readOnly) {
        titleEl.textContent = '正在执行';
        subEl.textContent = 'Agent 正在开发此任务，队列中其他项将按顺序等待。';
        btnStart.classList.add('hidden');
        btnSave.classList.add('hidden');
      } else if (pending) {
        titleEl.textContent = '开始开发';
        subEl.textContent = '可修改标题与需求描述；若无其他执行中任务将立即开始，否则进入队列末尾。';
        btnStart.classList.remove('hidden');
        btnSave.classList.add('hidden');
      } else {
        titleEl.textContent = st === 'Queued' ? '排队任务' : '编辑需求';
        subEl.textContent = st === 'Queued'
          ? '修改后保存；轮到该任务时会自动按队列顺序启动。'
          : '修改后点击「保存修改」写入 dev_state。';
        btnStart.classList.add('hidden');
        btnSave.classList.remove('hidden');
      }
      // 重置工具选择为默认 kimi
      const kimiRadio = document.querySelector('input[name="modal_tool_type"][value="kimi"]');
      if (kimiRadio) kimiRadio.checked = true;
      document.getElementById('start-modal').classList.remove('hidden');
    }
    function closeModal() {
      document.getElementById('start-modal').classList.add('hidden');
      document.getElementById('modal-task-title').disabled = false;
      document.getElementById('modal-task-desc').disabled = false;
      selectedFeature = null;
    }
    async function saveFeatureFromModal() {
      if (!selectedFeature || !currentProject) return;
      const featureId = selectedFeature.id;
      const name = document.getElementById('modal-task-title').value.trim();
      const description = document.getElementById('modal-task-desc').value;
      try {
        const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/${featureId}/content`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已保存', 'success');
          closeModal();
          refreshAllData();
        } else {
          showToast(data.error || '保存失败', 'error');
        }
      } catch (err) {
        showToast('保存失败: ' + err.message, 'error');
      }
    }
    async function confirmStartTask() {
      if (!selectedFeature || !currentProject) return;
      const featureId = selectedFeature.id;
      const name = document.getElementById('modal-task-title').value.trim();
      const description = document.getElementById('modal-task-desc').value;
      closeModal();
      await startDevelopment(featureId, { saveContent: true, name, description });
    }
    function switchInputMode(mode) {
      currentInputMode = mode;
      const naturalBtn = document.getElementById('mode-natural');
      const aiBtn = document.getElementById('mode-ai');
      const naturalPanel = document.getElementById('input-natural-panel');
      const aiPanel = document.getElementById('input-ai-panel');
      const aiParseBtn = document.getElementById('btn-ai-parse');
      const submitBtn = document.getElementById('btn-submit-feature');

      if (mode === 'natural') {
        naturalBtn.classList.add('bg-accent', 'text-dark-900');
        naturalBtn.classList.remove('text-gray-400');
        aiBtn.classList.remove('bg-accent', 'text-dark-900');
        aiBtn.classList.add('text-gray-400');
        naturalPanel.classList.remove('hidden');
        aiPanel.classList.add('hidden');
        aiParseBtn.classList.add('hidden');
        submitBtn.textContent = '提交需求';
      } else {
        aiBtn.classList.add('bg-accent', 'text-dark-900');
        aiBtn.classList.remove('text-gray-400');
        naturalBtn.classList.remove('bg-accent', 'text-dark-900');
        naturalBtn.classList.add('text-gray-400');
        aiPanel.classList.remove('hidden');
        naturalPanel.classList.add('hidden');
        aiParseBtn.classList.remove('hidden');
        submitBtn.textContent = '确认添加';
      }
    }
    async function parseWithAI() {
      const input = document.getElementById('ai-feature-input').value.trim();
      if (!input) {
        showToast('请输入需求描述', 'error');
        return;
      }

      // 检查API配置
      const settings = getSettings();
      if (!settings.apiKey) {
        showToast('请先配置API Key', 'error');
        openSettingsModal();
        return;
      }

      const btn = document.getElementById('btn-ai-parse');
      btn.disabled = true;
      btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> 解析中...';

      try {
        const res = await fetch(`${API_BASE}/api/ai/parse-requirement`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            input, 
            project_id: currentProject,
            settings: settings
          })
        });

        const data = await res.json();
        if (data.success) {
          aiParsedTasks = data.tasks || [];
          displayAIParsedTasks(aiParsedTasks);
          document.getElementById('ai-parse-result').classList.remove('hidden');
          showToast(`AI解析完成，识别出 ${aiParsedTasks.length} 个任务`, 'success');
        } else {
          showToast(data.error || 'AI解析失败', 'error');
        }
      } catch (err) {
        showToast('AI解析失败: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> AI解析';
      }
    }
    function displayAIParsedTasks(tasks) {
      const container = document.getElementById('ai-tasks-list');
      container.innerHTML = '';
      
      tasks.forEach((task, index) => {
        const taskEl = document.createElement('div');
        taskEl.className = 'p-2 bg-dark-700 rounded border border-dark-600';
        taskEl.innerHTML = `
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="text-sm text-white font-medium">${index + 1}. ${task.title}</div>
              <div class="text-xs text-gray-500 mt-1">${task.description || '暂无描述'}</div>
              <div class="flex items-center gap-2 mt-2">
                <span class="text-xs text-gray-400">${task.category || 'Feature'}</span>
              </div>
            </div>
          </div>
        `;
        container.appendChild(taskEl);
      });
    }
    async function submitFeature() {
      const autoStart = document.getElementById('feature-auto-start').checked;

      if (currentInputMode === 'natural') {
        // 自然语言模式 - 单条需求
        const title = document.getElementById('feature-title').value.trim();
        const description = document.getElementById('feature-desc').value.trim();
        const category = document.getElementById('feature-category').value;

        if (!title) {
          showToast('请输入需求标题', 'error');
          return;
        }

        try {
          const res = await fetch(`${API_BASE}/api/projects/${currentProject}/backlog`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, description, category, auto_start: autoStart })
          });

          const data = await res.json();
          if (data.success) {
            showToast(autoStart ? '需求已创建并自动开始开发！' : '需求已创建！', 'success');
            closeAddFeatureModal();
            refreshAllData();
          } else {
            showToast(data.error || '创建失败', 'error');
          }
        } catch (err) {
          showToast('提交失败: ' + err.message, 'error');
        }
      } else {
        // AI解析模式 - 批量添加
        if (aiParsedTasks.length === 0) {
          showToast('请先进行AI解析', 'error');
          return;
        }

        try {
          const res = await fetch(`${API_BASE}/api/projects/${currentProject}/features/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: aiParsedTasks, auto_start: autoStart })
          });

          const data = await res.json();
          if (data.success) {
            showToast(`已创建 ${data.created} 个需求` + (autoStart ? '，首个任务已开始开发' : ''), 'success');
            closeAddFeatureModal();
            refreshAllData();
          } else {
            showToast(data.error || '创建失败', 'error');
          }
        } catch (err) {
          showToast('提交失败: ' + err.message, 'error');
        }
      }
    }
    function getSettings() {
      const saved = localStorage.getItem('devmanager_settings');
      if (saved) {
        return JSON.parse(saved);
      }
      // 默认配置
      return {
        apiKey: '',
        baseUrl: 'https://api.stepfun.com/v1',
        model: 'step-3.5-flash'
      };
    }
    function saveSettingsToStorage(settings) {
      localStorage.setItem('devmanager_settings', JSON.stringify(settings));
    }
    function openSettingsModal() {
      const settings = getSettings();
      document.getElementById('settings-api-key').value = settings.apiKey || '';
      document.getElementById('settings-base-url').value = settings.baseUrl || 'https://api.stepfun.com/v1';
      document.getElementById('settings-model').value = settings.model || 'step-3.5-flash';
      document.getElementById('settings-modal').classList.remove('hidden');
    }
    function closeSettingsModal() {
      document.getElementById('settings-modal').classList.add('hidden');
    }
    function toggleApiKeyVisibility() {
      const input = document.getElementById('settings-api-key');
      const icon = document.getElementById('eye-icon');
      if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>';
      } else {
        input.type = 'password';
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>';
      }
    }
    async function testAIConnection() {
      const settings = {
        apiKey: document.getElementById('settings-api-key').value.trim(),
        baseUrl: document.getElementById('settings-base-url').value.trim() || 'https://api.stepfun.com/v1',
        model: document.getElementById('settings-model').value.trim() || 'step-3.5-flash'
      };

      if (!settings.apiKey) {
        showToast('请输入API Key', 'error');
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/api/ai/test-connection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });

        const data = await res.json();
        if (data.success) {
          showToast('连接成功: ' + data.model, 'success');
        } else {
          showToast(data.error || '连接失败', 'error');
        }
      } catch (err) {
        showToast('连接测试失败: ' + err.message, 'error');
      }
    }
    function saveSettings() {
      const settings = {
        apiKey: document.getElementById('settings-api-key').value.trim(),
        baseUrl: document.getElementById('settings-base-url').value.trim() || 'https://api.stepfun.com/v1',
        model: document.getElementById('settings-model').value.trim() || 'step-3.5-flash'
      };
      saveSettingsToStorage(settings);
      showToast('设置已保存', 'success');
      closeSettingsModal();
    }
