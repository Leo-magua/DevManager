    
    function openScanModal() {
      document.getElementById('scan-modal').classList.remove('hidden');
      loadScanStatus();
    }
    function closeScanModal() {
      document.getElementById('scan-modal').classList.add('hidden');
      document.getElementById('scan-results').classList.add('hidden');
    }
    async function loadScanStatus() {
      try {
        const res = await fetch(`${API_BASE}/api/scan/status`);
        const data = await res.json();
        document.getElementById('auto-scan-toggle').checked = data.auto_scan;
      } catch (err) {
        console.error('加载扫描状态失败:', err);
      }
    }
    async function toggleAutoScan(checkbox) {
      try {
        const res = await fetch(`${API_BASE}/api/scan/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto_scan: checkbox.checked, interval: 5 })
        });
        const data = await res.json();
        if (data.success) {
          showToast(checkbox.checked ? '自动扫描已开启' : '自动扫描已关闭', 'success');
        } else {
          showToast('设置失败', 'error');
          checkbox.checked = !checkbox.checked;
        }
      } catch (err) {
        showToast('设置失败: ' + err.message, 'error');
        checkbox.checked = !checkbox.checked;
      }
    }
    async function executeScan() {
      const btn = document.getElementById('scan-btn');
      const resultsDiv = document.getElementById('scan-results');
      const loadingDiv = document.getElementById('scan-loading');
      const contentDiv = document.getElementById('scan-results-content');

      btn.disabled = true;
      resultsDiv.classList.add('hidden');
      loadingDiv.classList.remove('hidden');

      try {
        const res = await fetch(`${API_BASE}/api/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        loadingDiv.classList.add('hidden');
        resultsDiv.classList.remove('hidden');

        if (data.success) {
          const results = data.results;
          contentDiv.innerHTML = '';

          // 统计信息
          const stats = document.createElement('div');
          stats.className = 'p-3 bg-dark-800 rounded border border-dark-600 mb-3';
          stats.innerHTML = `
            <div class="text-sm text-white mb-1">扫描完成</div>
            <div class="text-xs text-gray-400">
              扫描了 ${results.scanned} 个目录
              ${results.added.length > 0 ? `，新增 ${results.added.length} 个项目` : ''}
              ${results.updated.length > 0 ? `，更新 ${results.updated.length} 个项目` : ''}
            </div>
          `;
          contentDiv.appendChild(stats);

          // 新增的项目
          if (results.added.length > 0) {
            const addedDiv = document.createElement('div');
            addedDiv.className = 'mb-3';
            addedDiv.innerHTML = '<div class="text-xs text-emerald-400 mb-1">新增项目:</div>';
            results.added.forEach(p => {
              const item = document.createElement('div');
              item.className = 'p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-sm';
              item.innerHTML = `
                <span class="text-white font-medium">${p.name}</span>
                <span class="text-xs text-gray-400 ml-2">${p.tech_stack.join(', ') || 'Unknown'}</span>
              `;
              addedDiv.appendChild(item);
            });
            contentDiv.appendChild(addedDiv);
          }

          // 更新的项目（创建了缺失文件）
          if (results.updated.length > 0) {
            const updatedDiv = document.createElement('div');
            updatedDiv.className = 'mb-3';
            updatedDiv.innerHTML = '<div class="text-xs text-blue-400 mb-1">已更新项目:</div>';
            results.updated.forEach(p => {
              const item = document.createElement('div');
              item.className = 'p-2 bg-blue-500/10 border border-blue-500/30 rounded text-sm';
              item.innerHTML = `
                <span class="text-white">${p.name}</span>
                <span class="text-xs text-gray-400"> - 创建了: ${p.created.join(', ')}</span>
              `;
              updatedDiv.appendChild(item);
            });
            contentDiv.appendChild(updatedDiv);
          }

          // 错误
          if (results.errors.length > 0) {
            const errorsDiv = document.createElement('div');
            errorsDiv.className = 'mb-3';
            errorsDiv.innerHTML = '<div class="text-xs text-red-400 mb-1">错误:</div>';
            results.errors.forEach(e => {
              const item = document.createElement('div');
              item.className = 'p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-300';
              item.textContent = `${e.name}: ${e.error}`;
              errorsDiv.appendChild(item);
            });
            contentDiv.appendChild(errorsDiv);
          }

          // 如果没有变化
          if (results.added.length === 0 && results.updated.length === 0) {
            const noChange = document.createElement('div');
            noChange.className = 'p-3 bg-dark-800 rounded border border-dark-600 text-sm text-gray-400 text-center';
            noChange.textContent = '没有发现新项目，所有项目文件已就绪';
            contentDiv.appendChild(noChange);
          }

          // 刷新项目列表
          await loadProjects();
          
          showToast('扫描完成', 'success');
        } else {
          contentDiv.innerHTML = `<div class="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-300">扫描失败: ${data.error}</div>`;
          showToast('扫描失败', 'error');
        }
      } catch (err) {
        loadingDiv.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
        contentDiv.innerHTML = `<div class="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-300">扫描失败: ${err.message}</div>`;
        showToast('扫描失败: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    }
