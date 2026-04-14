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
