    const API_BASE = window.location.origin;
    const statusMap = {
      'Pending': { label: '待处理', class: 'border-amber-500/30 bg-amber-500/10 text-amber-400', col: 'col-pending' },
      'Queued': { label: '排队中', class: 'border-violet-500/30 bg-violet-500/10 text-violet-300', col: 'col-progress' },
      'In_Progress': { label: '执行中', class: 'border-red-500/40 bg-red-500/10 text-red-300', col: 'col-progress' },
      'Completed': { label: '已完成', class: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', col: 'col-completed' }
    };
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function showToast(msg, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      const colors = { success: 'bg-emerald-500/90', error: 'bg-red-500/90', info: 'bg-accent/90' };
      toast.className = `${colors[type]} text-white px-4 py-3 rounded-lg shadow-lg text-sm animate-fade-in`;
      toast.textContent = msg;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    function updateTime() {
      document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
    }
    function setConnection(ok) {
      const el = document.getElementById('connection-status');
      const dot = el.previousElementSibling;
      if (ok) {
        el.textContent = '已连接';
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400 status-dot';
      } else {
        el.textContent = '断开';
        dot.className = 'w-2 h-2 rounded-full bg-red-400';
      }
    }
    let authState = {
      enabled: false,
      authenticated: false,
      session_ttl_hours: 24
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, {
        credentials: 'same-origin',
        ...init
      });
      if (response.status === 401) {
        let payload = null;
        try {
          payload = await response.clone().json();
        } catch (_) {}
        handleUnauthorized(payload?.message || payload?.error || '开发相关操作需要先输入密码');
      }
      return response;
    };
    function handleUnauthorized(message) {
      authState.authenticated = false;
      renderAuthUI();
      openAuthModal(message || '开发相关操作需要先输入密码');
    }
    async function refreshAuthStatus(options = {}) {
      const { silent = false } = options;
      try {
        const res = await nativeFetch(`${API_BASE}/api/auth/status`, {
          credentials: 'same-origin'
        });
        const data = await res.json();
        authState = {
          enabled: !!data.enabled,
          authenticated: !!data.authenticated,
          session_ttl_hours: data.session_ttl_hours || 24
        };
        renderAuthUI();
        return authState;
      } catch (err) {
        if (!silent) {
          showToast('获取权限状态失败: ' + err.message, 'error');
        }
        return authState;
      }
    }
    function renderAuthUI() {
      const badge = document.getElementById('auth-status-badge');
      const summary = document.getElementById('auth-status-text');
      const readonly = document.getElementById('readonly-banner');
      const loginBtn = document.getElementById('auth-login-btn');
      const logoutBtn = document.getElementById('auth-logout-btn');
      const terminalInput = document.getElementById('terminal-input');

      if (!badge || !summary || !readonly || !loginBtn || !logoutBtn) return;

      if (!authState.enabled) {
        badge.textContent = '未配置';
        badge.className = 'px-2 py-1 text-xs rounded-full border border-amber-500/30 bg-amber-500/15 text-amber-300';
        summary.textContent = '开发密码未配置';
        readonly.classList.remove('hidden');
        readonly.textContent = '当前未配置开发密码，写操作会被后端拒绝。';
        loginBtn.classList.add('hidden');
        logoutBtn.classList.add('hidden');
        if (terminalInput) {
          terminalInput.disabled = false;
          terminalInput.placeholder = '输入命令并回车...';
        }
        return;
      }

      if (authState.authenticated) {
        badge.textContent = '已授权';
        badge.className = 'px-2 py-1 text-xs rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300';
        summary.textContent = `开发权限已启用，会话约 ${authState.session_ttl_hours} 小时`;
        readonly.classList.add('hidden');
        loginBtn.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
        if (terminalInput) {
          terminalInput.disabled = false;
          terminalInput.placeholder = '输入命令并回车...';
        }
      } else {
        badge.textContent = '只读';
        badge.className = 'px-2 py-1 text-xs rounded-full border border-dark-500 bg-dark-800 text-gray-300';
        summary.textContent = '当前为只读访问';
        readonly.classList.remove('hidden');
        readonly.textContent = '你可以查看项目状态，但新增需求、启动开发、终端输入、部署和配置修改都需要先登录。';
        loginBtn.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        if (terminalInput) {
          terminalInput.disabled = true;
          terminalInput.placeholder = '只读模式，登录后可输入命令';
        }
      }

      if (typeof term !== 'undefined' && term) {
        term.options.disableStdin = authState.enabled && !authState.authenticated;
      }
    }
    function requireWriteAccess(message = '该操作需要开发权限密码') {
      if (!authState.enabled || authState.authenticated) {
        return true;
      }
      openAuthModal(message);
      showToast(message, 'info');
      return false;
    }
    function openAuthModal(message = '') {
      const modal = document.getElementById('auth-modal');
      const hint = document.getElementById('auth-modal-hint');
      const input = document.getElementById('auth-password-input');
      if (!modal || !hint || !input) return;
      hint.textContent = message || '输入开发密码后，才能执行开发相关动作。';
      input.value = '';
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 0);
    }
    function closeAuthModal() {
      const modal = document.getElementById('auth-modal');
      if (modal) modal.classList.add('hidden');
    }
    async function loginWithPassword() {
      const input = document.getElementById('auth-password-input');
      if (!input) return;
      const password = input.value.trim();
      if (!password) {
        showToast('请输入开发密码', 'error');
        input.focus();
        return;
      }
      try {
        const res = await nativeFetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || data.error || '登录失败');
        }
        authState.authenticated = true;
        await refreshAuthStatus({ silent: true });
        closeAuthModal();
        if (typeof restartWebSocketConnection === 'function') {
          restartWebSocketConnection();
        }
        showToast('开发权限已解锁', 'success');
      } catch (err) {
        showToast('登录失败: ' + err.message, 'error');
      }
    }
    async function logoutAuth() {
      try {
        await nativeFetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          credentials: 'same-origin'
        });
      } catch (_) {}
      authState.authenticated = false;
      renderAuthUI();
      if (typeof restartWebSocketConnection === 'function') {
        restartWebSocketConnection();
      }
      showToast('已退出开发权限', 'info');
    }
