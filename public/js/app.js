(function () {
  'use strict';

  const root = document.getElementById('app-root');
  const WEBSITE_URL = 'https://www.hgsi.in/';
  let schema = null;
  let state = { view: 'home', filter: 'all', index: [], current: null, originalString: null, moduleSubTab: { crf: 'create', open_enrollment: 'create', termination: 'create', implementation: 'create' } };

  // ---------------- API helpers ----------------

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (!res.ok) throw new Error('API error ' + res.status + ' on ' + path);
    return res.json();
  }
  const loadSchema = () => api('/api/schema');
  const loadIndex = () => api('/api/submissions');
  const loadSubmission = async (id) => {
    if (state.isOffline) {
      const stored = localStorage.getItem('wfj_sub_' + id);
      return stored ? JSON.parse(stored) : { id, type: 'crf', header: {}, body: {}, tasks: [] };
    }
    return api('/api/submissions/' + id);
  };
  const createSubmission = async (type) => {
    if (state.isOffline) {
      const id = Date.now();
      const newSub = { id, type, status: 'draft', client: 'New Client', broker: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), header: {}, body: {}, tasks: [] };
      localStorage.setItem('wfj_sub_' + id, JSON.stringify(newSub));
      state.index.unshift(newSub);
      localStorage.setItem('wfj_offline_index', JSON.stringify(state.index));
      return newSub;
    }
    return api('/api/submissions', { method: 'POST', body: JSON.stringify({ type, status: 'draft' }) });
  };
  const patchSubmission = async (id, patch) => {
    if (state.isOffline) {
      const stored = localStorage.getItem('wfj_sub_' + id);
      let sub = stored ? JSON.parse(stored) : { id };
      Object.assign(sub, patch);
      sub.updated_at = new Date().toISOString();
      localStorage.setItem('wfj_sub_' + id, JSON.stringify(sub));
      const idxItem = state.index.find(x => String(x.id) === String(id));
      if (idxItem) Object.assign(idxItem, patch);
      localStorage.setItem('wfj_offline_index', JSON.stringify(state.index));
      return sub;
    }
    return api('/api/submissions/' + id, { method: 'PUT', body: JSON.stringify(patch) });
  };
  const removeSubmissionApi = async (id) => {
    if (state.isOffline) {
      localStorage.removeItem('wfj_sub_' + id);
      state.index = state.index.filter(x => String(x.id) !== String(id));
      localStorage.setItem('wfj_offline_index', JSON.stringify(state.index));
      return { success: true };
    }
    return api('/api/submissions/' + id, { method: 'DELETE' });
  };

  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d; } }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function cleanSubmission(sub) {
    if (!sub) return null;
    return {
      client: sub.client || '',
      broker: sub.broker || '',
      status: sub.status || 'requested',
      header: JSON.parse(JSON.stringify(sub.header || {})),
      body: JSON.parse(JSON.stringify(sub.body || {})),
      tasks: (sub.tasks || []).map(t => ({
        id: t.id,
        section_key: t.section_key,
        item_key: t.item_key,
        label: t.label,
        status: t.status,
        completed_on: t.completed_on,
        notes: t.notes,
        extra_json: JSON.parse(JSON.stringify(t.extra_json || {}))
      }))
    };
  }

  function isSubmissionDirty() {
    if (!state.current) return false;
    return JSON.stringify(cleanSubmission(state.current)) !== state.originalString;
  }

  function checkUnsavedChanges() {
    if (isSubmissionDirty()) {
      return confirm('You have unsaved changes. Are you sure you want to discard them?');
    }
    return true;
  }

  window.addEventListener('beforeunload', (e) => {
    if (isSubmissionDirty()) {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  function setSaveState(s) {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    if (s === 'saving') {
      el.textContent = 'Saving…';
      el.className = 'save-indicator saving';
    } else if (s === 'saved') {
      el.textContent = 'Saved';
      el.className = 'save-indicator saved';
    } else if (s === 'unsaved' || isSubmissionDirty()) {
      el.textContent = 'Unsaved Changes';
      el.className = 'save-indicator unsaved';
    } else {
      el.textContent = '';
      el.className = 'save-indicator';
    }
  }

  function wireSaveButton(main, sub) {
    const btn = main.querySelector('#save-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      btn.textContent = 'Saving…'; btn.disabled = true;
      setSaveState('saving');
      try {
        if (sub.status === 'draft') sub.status = 'requested';
        const saved = await patchSubmission(sub.id, cleanSubmission(sub));
        state.current = saved;
        state.originalString = JSON.stringify(cleanSubmission(saved));
        setSaveState('saved');
        btn.textContent = 'Saved ✓';
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
      } catch (err) {
        alert('Save failed: ' + err.message);
        btn.textContent = 'Save'; btn.disabled = false;
        setSaveState('unsaved');
      }
    });
  }

  // Label helpers used across the app
  function typeLabelOf(type) {
    if (type === 'crf') return 'Change Request (CRF)';
    if (type === 'open_enrollment') return 'Open Enrollment';
    if (type === 'termination') return 'Client Termination';
    if (type === 'implementation') return 'Client Implementation';
    return (type || 'Module').charAt(0).toUpperCase() + (type || '').slice(1);
  }
  function wireGlobalSearch(root) {
    const input = root.querySelector('#global-search-input');
    const resultsBox = root.querySelector('#global-search-results');
    if (!input || !resultsBox) return;

    // Status pill config for search results
    const statusConfig = {
      requested: { label: 'Requested', bg: '#eff6ff', color: '#2563eb' },
      approved: { label: 'Approved', bg: '#ecfdf5', color: '#059669' },
      testing: { label: 'In Review', bg: '#fffbeb', color: '#d97706' },
      in_progress: { label: 'In Progress', bg: '#fffbeb', color: '#d97706' },
      review: { label: 'In Review', bg: '#fffbeb', color: '#d97706' },
      completed: { label: 'Completed', bg: '#f5f3ff', color: '#7c3aed' },
    };

    // Avatar color by type
    const typeColors = {
      crf: 'linear-gradient(135deg,#6C5CE7,#5645D1)',
      open_enrollment: 'linear-gradient(135deg,#2E86AB,#1a6882)',
      termination: 'linear-gradient(135deg,#E17055,#c05c45)',
      implementation: 'linear-gradient(135deg,#00B894,#008f73)',
    };

    function doSearch(q) {
      q = q.trim().toLowerCase();
      if (!q) { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; return; }

      const matches = state.index.filter(r => {
        const fields = [
          r.client, r.broker, r.refConversation, r.type, r.status,
          r.configAnalyst, r.testingAnalyst, r.implementationManager,
          r.requestedBy, r.taskText, r.headcount
        ];
        return fields.some(f => f !== undefined && f !== null && String(f).toLowerCase().includes(q));
      }).slice(0, 20);

      if (matches.length === 0) {
        resultsBox.innerHTML = `
          <div class="global-search-header">Search Results</div>
          <div class="global-search-empty">
            <div class="search-empty-icon">🔍</div>
            No results for <strong>${esc(q)}</strong><br>
            <span style="font-size:11px;opacity:0.7;">Try a different client name or broker</span>
          </div>`;
      } else {
        const sc = statusConfig;
        resultsBox.innerHTML = `
          <div class="global-search-header">${matches.length} result${matches.length !== 1 ? 's' : ''} found</div>
          ${matches.map(r => {
          const initials = (r.client || 'U').trim().charAt(0).toUpperCase();
          const s = sc[r.status] || { label: r.status || 'Requested', bg: '#f1f5f9', color: '#64748b' };
          const avatarBg = typeColors[r.type] || typeColors.crf;
          const meta = [typeLabelOf(r.type), r.broker ? esc(r.broker) : null, r.refConversation ? 'Conv# ' + esc(r.refConversation) : null].filter(Boolean).join(' · ');
          return `
              <div class="global-search-item" data-open="${r.id}">
                <div class="global-search-avatar" style="background:${avatarBg};">${initials}</div>
                <div class="global-search-item-body">
                  <div class="global-search-item-name">${esc(r.client || 'Untitled')}</div>
                  <div class="global-search-item-meta">${meta}</div>
                </div>
                <span class="global-search-status" style="background:${s.bg};color:${s.color};">${s.label}</span>
              </div>`;
        }).join('')}`;
      }

      resultsBox.style.display = 'block';
    }

    input.addEventListener('input', debounce(() => doSearch(input.value), 200));
    input.addEventListener('focus', () => { if (input.value.trim()) doSearch(input.value); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { resultsBox.style.display = 'none'; input.value = ''; input.blur(); } });

    // Clear button wiring
    const clearBtn = root.querySelector('#global-search-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        resultsBox.style.display = 'none';
        resultsBox.innerHTML = '';
        input.focus();
      });
    }

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); input.focus(); input.select(); }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.global-search-wrap')) resultsBox.style.display = 'none';
    });

    resultsBox.addEventListener('click', (e) => {
      const item = e.target.closest('[data-open]');
      if (item) {
        resultsBox.style.display = 'none';
        input.value = '';
        openSubmission(item.dataset.open);
      }
    });
  }

  function stageLabelOf(status) {
    if (!status) return 'Requested';
    if (status === 'requested') return 'Requested';
    if (status === 'approved') return 'Approved';
    if (status === 'testing' || status === 'in_progress' || status === 'review') return 'In Review / Testing';
    if (status === 'completed') return 'Completed';
    return String(status).charAt(0).toUpperCase() + String(status).slice(1);
  }

  async function saveCurrent() {
    const sub = state.current;
    if (!sub) return;
    setSaveState('saving');
    try {
      const saved = await patchSubmission(sub.id, cleanSubmission(sub));
      state.current = saved;
      state.originalString = JSON.stringify(cleanSubmission(saved));
      state.index = await loadIndex();
      setSaveState('saved');
    } catch (e) {
      setSaveState('unsaved');
      throw e;
    }
  }

  // ---------------- Navigation ----------------

  async function goView(v) {
    if (!checkUnsavedChanges()) return;
    state.view = v; state.current = null; state.index = await loadIndex(); render();
  }
  window.openSubmission = openSubmission;
  window.openModule = openModule;
  async function openSubmission(id) {
    if (!checkUnsavedChanges()) return;
    try {
      const sub = await loadSubmission(id);
      if (!sub || sub.error) {
        alert('Submission not found or already deleted.');
        state.index = await loadIndex();
        state.view = 'home';
        state.current = null;
        render();
        return;
      }
      state.current = sub;
      state.originalString = JSON.stringify(cleanSubmission(state.current));
      // Ensure view points to sub.type and subtab is 'create'
      const targetType = sub.type || 'crf';
      state.view = targetType;
      if (!state.moduleSubTab) state.moduleSubTab = {};
      state.moduleSubTab[targetType] = 'create';
      render();
    } catch (err) {
      alert('Could not open submission: ' + err.message);
    }
  }
  async function createNew(type) {
    if (!checkUnsavedChanges()) return;
    state.current = await createSubmission(type);

    const today = new Date().toISOString().slice(0, 10);
    if (!state.current.header) state.current.header = {};
    if (!state.current.body) state.current.body = {};

    if (type === 'crf') {
      if (!state.current.body.request) state.current.body.request = {};
      state.current.body.request.dateOfRequest = today;
    } else if (type === 'termination') {
      state.current.header.requestedDate = today;
    }

    state.originalString = JSON.stringify(cleanSubmission(state.current));
    state.view = type;
    state.index = await loadIndex();
    render();
  }
  async function removeSubmission(id, evt) {
    if (evt) evt.stopPropagation();
    if (!confirm('Delete this submission? This cannot be undone.')) return;
    try {
      await removeSubmissionApi(id);
      if (state.current && String(state.current.id) === String(id)) {
        state.current = null;
        state.view = 'submissions';
      }
      state.index = await loadIndex();
      render();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  // ---------------- Shell ----------------


  function render() {
    const totalCount = state.index.length;
    const activeView = state.view || 'home';

    root.innerHTML = `
      <header class="topbar">
        <img class="brand-logo" src="images/logo.png" alt="Workforce Junction" data-goto="home">
        
        <nav class="top-header-nav">
          <div class="nav-tab ${activeView === 'home' ? 'active' : ''}" data-goto="home">Home</div>
          <div class="nav-tab ${activeView === 'crf' ? 'active' : ''}" data-goto="crf">Change Requests</div>
          <div class="nav-tab ${activeView === 'open_enrollment' ? 'active' : ''}" data-goto="open_enrollment">Open Enrollment</div>
          <div class="nav-tab ${activeView === 'termination' ? 'active' : ''}" data-goto="termination">Termination</div>
          <div class="nav-tab ${activeView === 'implementation' ? 'active' : ''}" data-goto="implementation">Implementation</div>
          <div class="nav-tab ${activeView === 'tracker' ? 'active' : ''}" data-goto="tracker">Tracker &amp; Analytics</div>
          <div class="nav-tab ${activeView === 'about' ? 'active' : ''}" data-goto="about">About</div>
        </nav>

        <div class="topbar-spacer"></div>

        <div class="topbar-right-actions">

          <!-- Search Bar Component -->
          <div class="global-search-wrap">
            <span class="global-search-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input type="text" id="global-search-input" class="global-search-input"
                  placeholder="Search client, broker…">
            <button class="global-search-clear" id="global-search-clear-btn" tabindex="-1" title="Clear search">&times;</button>
            <span class="global-search-kbd">Ctrl+K</span>
            <div id="global-search-results" class="global-search-results"></div>
          </div>

          <!-- Divider between Search & Bell -->
          <div class="topbar-divider"></div>

          <!-- Notification Bell Component -->
          <div class="notif-bell" id="notif-bell" title="Notifications">
            🔔
            <div class="notif-badge" id="notif-badge" style="display:none;">0</div>
            <div class="notif-dropdown" id="notif-dropdown">
              <div class="notif-header">Recent Requests <span style="font-size:11px;font-weight:400;color:var(--ink-soft);cursor:pointer;" id="notif-clear">Dismiss All</span></div>
              <div id="notif-list"></div>
            </div>
          </div>

          <div class="save-indicator" id="save-indicator"></div>
          <button class="mobile-menu-btn" id="mobile-menu-btn">☰</button>
        </div>
      </header>

      <div class="mobile-nav-drawer" id="mobile-nav-drawer">
        <div class="mobile-nav-item ${activeView === 'home' ? 'active' : ''}" data-goto="home">🏠 Home</div>
        <div class="mobile-nav-item ${activeView === 'crf' ? 'active' : ''}" data-goto="crf">📄 Change Requests (CRF)</div>
        <div class="mobile-nav-item ${activeView === 'open_enrollment' ? 'active' : ''}" data-goto="open_enrollment">📅 Open Enrollment</div>
        <div class="mobile-nav-item ${activeView === 'termination' ? 'active' : ''}" data-goto="termination">👤 Termination</div>
        <div class="mobile-nav-item ${activeView === 'implementation' ? 'active' : ''}" data-goto="implementation">👥 Implementation</div>
        <div class="mobile-nav-item ${activeView === 'tracker' ? 'active' : ''}" data-goto="tracker">📊 Tracker &amp; Analytics</div>
        <div class="mobile-nav-item ${activeView === 'about' ? 'active' : ''}" data-goto="about">ℹ️ About</div>
      </div>

      <div class="app-body">
        <div class="main-area" id="main-area"></div>
      </div>
      
    `;

    root.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => {
      closeMobileNav();
      const targetView = el.dataset.goto;
      if (['crf', 'open_enrollment', 'termination', 'implementation'].includes(targetView)) {
        openModule(targetView);
      } else {
        goView(targetView);
      }
    }));

    const mobileBtn = document.getElementById('mobile-menu-btn');
    const mobileDrawer = document.getElementById('mobile-nav-drawer');
    if (mobileBtn && mobileDrawer) {
      mobileBtn.addEventListener('click', () => mobileDrawer.classList.toggle('open'));
    }

    // Notifications Logic
    const requestedItems = state.dismissedNotifs ? [] : state.index.filter(x => x.status === 'requested');
    const notifBadge = document.getElementById('notif-badge');
    const notifDropdown = document.getElementById('notif-dropdown');
    const notifList = document.getElementById('notif-list');

    if (requestedItems.length > 0) {
      notifBadge.textContent = requestedItems.length;
      notifBadge.style.display = 'block';
    } else {
      notifBadge.style.display = 'none';
    }

    notifList.innerHTML = requestedItems.length === 0 ? '<div class="notif-empty">No new requests</div>' : requestedItems.map(r => `
      <div class="notif-item" data-notif-open="${r.id}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;">
        <div style="flex:1;">
          <div class="notif-item-title">${typeLabelOf(r.type)}: ${esc(r.client || 'Untitled')}</div>
          <div class="notif-item-meta">Updated: ${fmtDate(r.updatedAt)}</div>
        </div>
        <button style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #2563eb;background:#eff6ff;color:#2563eb;font-weight:700;cursor:pointer;white-space:nowrap;" onclick="event.stopPropagation();" data-notif-open="${r.id}">View →</button>
      </div>
    `).join('');

    document.getElementById('notif-bell').addEventListener('click', (e) => {
      if (e.target.closest('#notif-dropdown') && !e.target.closest('#notif-clear')) return;
      notifDropdown.classList.toggle('open');
    });

    document.getElementById('notif-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      state.dismissedNotifs = true;
      notifDropdown.classList.remove('open');
      render();
    });
    wireGlobalSearch(root);
    notifList.querySelectorAll('[data-notif-open]').forEach(el => el.addEventListener('click', (e) => {
      e.stopPropagation();
      notifDropdown.classList.remove('open');
      openSubmission(el.dataset.notifOpen);
    }));

    const main = document.getElementById('main-area');
    if (state.view === 'home') renderHome(main);
    else if (state.view === 'about') renderAbout(main);
    else if (state.view === 'tracker') renderTracker(main);
    else if (['crf', 'open_enrollment', 'termination', 'implementation'].includes(state.view)) {
      renderModuleFrame(main, state.view);
    } else renderHome(main);
  }

  function goView(view) {
    if (!checkUnsavedChanges()) return;
    state.view = view;
    render();
  }

  function closeMobileNav() {
    const md = document.getElementById('mobile-nav-drawer');
    if (md) md.classList.remove('open');
  }


  async function openModule(type) {
    if (!checkUnsavedChanges()) return;
    state.view = type;
    if (!state.moduleSubTab) state.moduleSubTab = {};
    // Reset to create tab so new form is always shown fresh when navigating
    state.moduleSubTab[type] = 'create';
    // Clear current so renderModuleCreateForm creates a fresh form
    state.current = null;
    render();
  }


  // ---------------- Module Frame Engine (Create | Analysis | Status | Reports | Recycle Bin) ----------------

  async function renderModuleFrame(main, moduleType) {
    const activeSubTab = (state.moduleSubTab && state.moduleSubTab[moduleType]) || 'create';
    const titleMap = {
      crf: 'Change Request Form (CRF)',
      open_enrollment: 'Open Enrollment',
      termination: 'Client Termination',
      implementation: 'Client Implementation'
    };
    const iconMap = { crf: '📄', open_enrollment: '📅', termination: '👤', implementation: '👥' };

    main.innerHTML = `
      <div style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
          <span style="font-size:24px;">${iconMap[moduleType] || '📋'}</span>
          <h2 style="margin:0;font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:700;">${titleMap[moduleType] || moduleType}</h2>
        </div>
        <div style="color:var(--ink-soft);font-size:13px;">Manage details, analytics, workflow status, reports, and recycle bin for ${titleMap[moduleType]}</div>
      </div>

      <!-- 5 Sub-Tabs Bar: Create | Analysis | Status & Pipeline | Reports | Recycle Bin -->
      <div class="sub-tabs-bar">
        <button class="sub-tab-btn ${activeSubTab === 'create' ? 'active' : ''}" data-subtab="create">✏️ Create ${typeLabelOf(moduleType)}</button>
        <button class="sub-tab-btn ${activeSubTab === 'analysis' ? 'active' : ''}" data-subtab="analysis">📊 Analysis</button>
        <button class="sub-tab-btn ${activeSubTab === 'status' ? 'active' : ''}" data-subtab="status">📈 Status &amp; Pipeline</button>
        <button class="sub-tab-btn ${activeSubTab === 'reports' ? 'active' : ''}" data-subtab="reports">📋 Reports</button>
        <button class="sub-tab-btn ${activeSubTab === 'recycle' ? 'active' : ''}" data-subtab="recycle">🗑️ Recycle Bin</button>
      </div>

      <div id="module-subtab-content"></div>
    `;

    main.querySelectorAll('[data-subtab]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!state.moduleSubTab) state.moduleSubTab = {};
        state.moduleSubTab[moduleType] = btn.dataset.subtab;
        renderModuleFrame(main, moduleType);
      });
    });

    const subContent = main.querySelector('#module-subtab-content');

    if (activeSubTab === 'create') {
      await renderModuleCreateForm(subContent, moduleType);
    } else if (activeSubTab === 'analysis') {
      await renderModuleAnalysis(subContent, moduleType);
    } else if (activeSubTab === 'status') {
      await renderModuleStatus(subContent, moduleType);
    } else if (activeSubTab === 'reports') {
      await renderModuleReportsOnly(subContent, moduleType);
    } else if (activeSubTab === 'recycle') {
      await renderModuleRecycleBinOnly(subContent, moduleType);
    }
  }


  async function renderModuleCreateForm(container, moduleType) {
    // If no current or wrong type, create a fresh empty submission
    if (!state.current || state.current.type !== moduleType) {
      state.current = await createSubmission(moduleType);
      state.current.client = '';
      state.current.broker = '';
      state.current.header = {};
      state.current.body = {};
      state.originalString = JSON.stringify(cleanSubmission(state.current));
    }

    const formArea = document.createElement('div');
    container.appendChild(formArea);

    if (moduleType === 'crf') renderCRF(formArea);
    else if (moduleType === 'termination') renderTermination(formArea);
    else if (moduleType === 'implementation') renderImplementation(formArea);
    else if (moduleType === 'open_enrollment') renderOpenEnrollment(formArea);
    else renderCRF(formArea);

    // Inject ONLY 2 Action Buttons: Cancel and Submit Request
    const actionContainer = document.createElement('div');
    actionContainer.className = 'mockup-card';
    actionContainer.style.marginTop = '20px';
    actionContainer.style.padding = '18px 24px';
    actionContainer.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div style="font-size:13.5px;font-weight:600;color:var(--ink-soft);">
          Form Actions for <strong>${typeLabelOf(moduleType)}</strong>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <button class="btn btn-ghost" id="action-btn-cancel" style="padding:10px 22px;">❌ Cancel</button>
          <button class="btn btn-primary" id="action-btn-submit" style="background:#10b981;padding:10px 26px;font-weight:700;">🚀 Submit Request</button>
        </div>
      </div>
    `;
    formArea.appendChild(actionContainer);

    // Collect DOM inputs into state.current before submitting
    function collectFormInputs() {
      const sub = state.current;
      if (!sub) return;
      formArea.querySelectorAll('[data-field]').forEach(el => {
        const key = el.dataset.field;
        if (key.startsWith('header.')) {
          const hk = key.split('.')[1];
          if (!sub.header) sub.header = {};
          sub.header[hk] = el.value;
        } else {
          sub[key] = el.value;
        }
      });
      formArea.querySelectorAll('[data-crf-path]').forEach(el => {
        const path = el.getAttribute('data-crf-path');
        const parts = path.split('.');
        if (parts.length === 2) {
          if (!sub.body) sub.body = {};
          if (!sub.body[parts[0]]) sub.body[parts[0]] = {};
          if (el.type === 'radio') {
            if (el.checked) sub.body[parts[0]][parts[1]] = el.value;
          } else {
            sub.body[parts[0]][parts[1]] = el.value;
          }
        }
      });
    }

    actionContainer.querySelector('#action-btn-cancel').addEventListener('click', () => {
      if (confirm('Discard edits and return to Home?')) {
        goView('home');
      }
    });

    actionContainer.querySelector('#action-btn-submit').addEventListener('click', async () => {
      collectFormInputs();
      if (state.current) {
        state.current.status = 'requested';
        await saveCurrent();
        state.dismissedNotifs = false;
        state.index = await loadIndex();
        render();
        alert('Submitted Request successfully! Appears in the Notification bell icon.');
      }
    });
  }



  // ---------------- Module Analysis Tab ----------------
  async function renderModuleAnalysis(container, moduleType) {
    container.innerHTML = '<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>';
    state.index = await loadIndex();
    const rows = state.index.filter(r => r.type === moduleType);
    const totalRows = rows.length;
    const colors = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#f97316'];

    let slices, legendTitle;

    if (moduleType === 'implementation' || moduleType === 'termination') {
      // Build Clients / Broker / EE Headcount breakdown
      const clientSet = new Set(), brokerSet = new Set();
      let headcountTotal = 0;
      rows.forEach(r => {
        if (r.client) clientSet.add(r.client);
        if (r.broker) brokerSet.add(r.broker);
        headcountTotal += (parseInt(r.headcount, 10) || 0);
      });
      const accent = moduleType === 'implementation' ? '#10b981' : '#ef4444';
      const accent2 = moduleType === 'implementation' ? '#34d399' : '#f87171';
      const accent3 = moduleType === 'implementation' ? '#a7f3d0' : '#fca5a5';
      slices = [
        { label: 'Clients', value: clientSet.size, color: accent },
        { label: 'Broker', value: brokerSet.size, color: accent2 },
        { label: 'EE Headcount', value: Math.max(1, Math.round(headcountTotal / 100) || 0), displayVal: headcountTotal.toLocaleString(), color: accent3 }
      ];
      legendTitle = 'Clients / Broker / Headcount';
    } else {
      // CRF / Open Enrollment keep the category breakdown
      const catCount = {};
      rows.forEach(r => {
        const c = r.category || 'Other';
        catCount[c] = (catCount[c] || 0) + 1;
      });
      slices = Object.keys(catCount).map((k, i) => ({ label: k, value: catCount[k], color: colors[i % colors.length] }));
      if (slices.length === 0) slices.push({ label: 'No Data', value: 1, color: '#e2e8f0' });
      legendTitle = 'By Category';
    }

    const tot = slices.reduce((s, x) => s + x.value, 0) || 1;
    const legendHtml = slices.map(s => `
    <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:6px;">
      <span style="width:11px;height:11px;border-radius:50%;background:${s.color};flex-shrink:0;"></span>
      <span style="flex:1;">${s.label}</span>
      <span style="font-weight:700;">${s.displayVal || s.value} <span style="color:#94a3b8;font-weight:400;">(${Math.round(s.value / tot * 100)}%)</span></span>
    </div>
  `).join('');

    container.innerHTML = `
    <div class="mockup-card" style="padding:24px;margin-bottom:20px;">
      <div style="font-size:18px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;margin-bottom:20px;">
        ${typeLabelOf(moduleType)} — Analytics
      </div>
      ${totalRows === 0 ? `<div style="text-align:center;padding:40px;color:#94a3b8;font-size:15px;">📭 No records yet. Create a new ${typeLabelOf(moduleType)} to see analytics here.</div>` : `
        <div style="display:flex;align-items:center;gap:30px;flex-wrap:wrap;">
          ${buildDetailedDonutSvg(slices, 200, 'Total', totalRows)}
          <div style="flex:1;min-width:200px;">
            <div style="font-size:13px;font-weight:700;color:#475569;margin-bottom:12px;">${legendTitle}</div>
            ${legendHtml}
          </div>
        </div>
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f1f5f9;">
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;">📈 Submissions Trend</div>
          ${buildTimelineSvg(rows, 1100, 120)}
        </div>
      `}
    </div>
  `;
    setupDonutTooltips(container);
  }

  // ---------------- Module Status & Pipeline Tab ----------------
  async function renderModuleStatus(container, moduleType) {
    container.innerHTML = '<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>';
    state.index = await loadIndex();
    const rows = state.index.filter(r => r.type === moduleType);

    const stages = [
      { key: 'requested', label: '📋 Requested', color: '#2563eb', bg: '#eff6ff' },
      { key: 'approved', label: '✅ Approved', color: '#10b981', bg: '#ecfdf5' },
      { key: 'testing', label: '🔍 In Review', color: '#f59e0b', bg: '#fffbeb' },
      { key: 'completed', label: '🏁 Completed', color: '#8b5cf6', bg: '#f5f3ff' }
    ];

    const counts = {};
    stages.forEach(s => { counts[s.key] = rows.filter(r => (r.status || 'requested') === s.key).length; });

    const summaryCards = stages.map(s => `
      <div style="background:${s.bg};border:1px solid ${s.color}22;border-radius:12px;padding:18px;text-align:center;">
        <div style="font-size:28px;font-weight:800;color:${s.color};">${counts[s.key]}</div>
        <div style="font-size:12px;font-weight:600;color:#475569;margin-top:4px;">${s.label}</div>
      </div>
    `).join('');

    const pipelineColumns = stages.map(s => {
      const stageRows = rows.filter(r => (r.status || 'requested') === s.key);
      const cards = stageRows.length === 0
        ? '<div style="text-align:center;color:#cbd5e1;font-size:12px;padding:16px 0;">No records</div>'
        : stageRows.slice(0, 8).map(r => `
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:box-shadow .15s,border-color .15s;"
                 onmouseover="this.style.boxShadow='0 4px 12px rgba(37,99,235,.12)';this.style.borderColor='#93c5fd'"
                 onmouseout="this.style.boxShadow='';this.style.borderColor='#e2e8f0'"
                 data-open-sub="${r.id}">
              <div style="font-size:12.5px;font-weight:700;color:#1e293b;">${esc(r.client || 'Untitled')}</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;">${r.broker ? r.broker + ' · ' : ''}Updated: ${fmtDate(r.updatedAt)}</div>
              <div style="font-size:10.5px;color:#2563eb;margin-top:5px;font-weight:600;">Click to view details →</div>
            </div>
          `).join('');

      return `
        <div style="flex:1;min-width:200px;">
          <div style="font-size:12px;font-weight:700;color:${s.color};text-transform:uppercase;letter-spacing:.5px;padding:8px 12px;background:${s.bg};border-radius:8px;margin-bottom:10px;display:flex;justify-content:space-between;">
            <span>${s.label}</span><span style="background:${s.color};color:#fff;border-radius:10px;padding:1px 8px;">${counts[s.key]}</span>
          </div>
          ${cards}
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;">
          ${summaryCards}
        </div>
        <div class="mockup-card" style="padding:20px;">
          <div style="font-size:16px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;margin-bottom:18px;">
            Workflow Pipeline — ${typeLabelOf(moduleType)}
          </div>
          ${rows.length === 0
        ? '<div style="text-align:center;padding:40px;color:#94a3b8;font-size:15px;">📭 No records yet to show in the pipeline.</div>'
        : '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">' + pipelineColumns + '</div>'
      }
        </div>
      </div>
    `;

    // Wire pipeline card clicks to open full submission detail
    container.querySelectorAll('[data-open-sub]').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.openSub;
        if (!checkUnsavedChanges()) return;
        try {
          const sub = await loadSubmission(id);
          if (!sub || sub.error) { alert('Record not found.'); return; }
          state.current = sub;
          state.originalString = JSON.stringify(cleanSubmission(sub));
          state.view = sub.type;
          if (!state.moduleSubTab) state.moduleSubTab = {};
          state.moduleSubTab[sub.type] = 'create'; // show form with this record pre-filled
          render();
        } catch (err) { alert('Could not open record: ' + err.message); }
      });
    });
  }

  // ---------------- Reports Tab (Full Original Excel Headers) ----------------

  async function renderModuleReportsOnly(container, moduleType) {
    const rawData = await api('/api/tracker/data');
    const key = moduleType === 'crf' ? 'crf' : moduleType === 'termination' ? 'termination' : moduleType === 'implementation' ? 'implementation' : 'open_enrollment';
    const records = (rawData[key] || []).filter(r => !r.is_deleted);

    state.reportsDateFieldFilter = state.reportsDateFieldFilter || {};
    const selectedDateField = state.reportsDateFieldFilter[moduleType] || 'any';
    state.reportsYearFilter = state.reportsYearFilter || {};
    const selectedYear = state.reportsYearFilter[moduleType] || 'all';

    const getTargetDate = (r, fieldType) => {
      if (fieldType === 'received') return r.requestDate || r.oeDocReceivedDate || r.renewalDocReceivedDate || r.designGuideReceived || r.terminationDate;
      if (fieldType === 'completed') return r.completedDate || r.implementationCompletion || r.clientGoLive || r.oeEffectiveDate || r.oeFinalizationDate;
      if (fieldType === 'updated') return r.updatedAt || r.createdAt || r.created_at;
      return r.requestDate || r.oeDocReceivedDate || r.renewalDocReceivedDate || r.designGuideReceived || r.terminationDate || r.completedDate || r.implementationCompletion || r.clientGoLive || r.oeEffectiveDate || r.oeFinalizationDate || r.updatedAt || r.createdAt || r.created_at;
    };

    // Extract unique years from records based on selected date field
    const yearsSet = new Set();
    records.forEach(r => {
      const dStr = getTargetDate(r, selectedDateField);
      if (dStr) {
        const y = new Date(dStr).getFullYear();
        if (!isNaN(y) && y > 2000 && y < 2100) yearsSet.add(y);
      }
    });
    yearsSet.add(new Date().getFullYear());
    const years = Array.from(yearsSet).sort((a, b) => b - a);

    // Filter by date field and year
    const displayRecords = records.filter(r => {
      const dStr = getTargetDate(r, selectedDateField);
      if (selectedYear !== 'all') {
        if (!dStr) return false;
        if (String(new Date(dStr).getFullYear()) !== String(selectedYear)) return false;
      }
      return true;
    });

    let tableHeadersHtml = '';
    let tableRowsHtml = '';

    if (moduleType === 'crf') {
      tableHeadersHtml = `
        <tr>
          <th>#</th><th>Month</th><th>Client Name</th><th>Partner Name</th><th>Conversation #</th>
          <th>Change Requested By</th><th>Change Request Date</th><th>Category</th>
          <th>Reason for Raising</th><th>Change Request</th>
          <th>Time Spent on Configuration</th><th>Time Spent on Review/Testing</th><th>Total Time</th>
          <th>No. of Errors</th><th>Configuration Analyst</th><th>Review/Testing Analyst</th>
          <th>Implementation Manager/CRM</th><th>Completed Date</th><th>Rating</th>
          <th>Comments</th><th>Billable/Non-Billable</th><th>Status</th>
        </tr>
      `;
      tableRowsHtml = displayRecords.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(r.month || '—')}</td>
          <td style="font-weight:600;">${esc(r.client || 'Untitled')}</td>
          <td>${esc(r.broker || '—')}</td>
          <td>${esc(r.refConversation || '—')}</td>
          <td>${esc(r.requestedBy || '—')}</td>
          <td>${fmtDate(r.requestDate)}</td>
          <td><span style="font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--accent-soft);color:var(--accent-dark);">${esc(r.category || 'Plan Configuration')}</span></td>
          <td style="max-width:220px;white-space:normal;">${esc(r.reason || '—')}</td>
          <td style="max-width:220px;white-space:normal;">${esc(r.changeRequest || '—')}</td>
          <td>${esc(r.timeConfig || '0')}</td>
          <td>${esc(r.timeTesting || '0')}</td>
          <td><strong>${(parseFloat(r.timeConfig || 0) + parseFloat(r.timeTesting || 0)).toFixed(1)}</strong></td>
          <td>${esc(r.errors || '0')}</td>
          <td>${esc(r.configAnalyst || '—')}</td>
          <td>${esc(r.testingAnalyst || '—')}</td>
          <td>${esc(r.implementationManager || '—')}</td>
          <td>${fmtDate(r.completedDate)}</td>
          <td>${esc(r.rating || '—')}</td>
          <td style="max-width:200px;white-space:normal;">${esc(r.comments || '—')}</td>
          <td>${esc(r.billable || 'Billable')}</td>
          <td><span class="stagepill-table stage-${r.status || 'requested'}">${stageLabelOf(r.status || 'requested')}</span></td>
        </tr>
      `).join('');
    } else if (moduleType === 'implementation') {
      tableHeadersHtml = `
        <tr>
          <th>#</th><th>Broker</th><th>Headcount</th><th>Client Name</th>
          <th>Design Guide Received</th><th>Implementation Completion</th><th>Client Go-Live</th><th>Status</th>
        </tr>
      `;
      tableRowsHtml = displayRecords.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(r.broker || '—')}</td>
          <td><strong>${esc(r.headcount || '0')}</strong></td>
          <td style="font-weight:600;">${esc(r.client || 'Untitled')}</td>
          <td>${fmtDate(r.designGuideReceived)}</td>
          <td>${fmtDate(r.implementationCompletion)}</td>
          <td>${fmtDate(r.clientGoLive)}</td>
          <td><span class="stagepill-table stage-${r.status || 'requested'}">${stageLabelOf(r.status || 'requested')}</span></td>
        </tr>
      `).join('');
    } else if (moduleType === 'termination') {
      tableHeadersHtml = `
        <tr>
          <th>#</th><th>Broker</th><th>Headcount</th><th>Client Name</th>
          <th>Termination Date</th><th>Reason</th><th>Status</th>
        </tr>
      `;
      tableRowsHtml = displayRecords.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(r.broker || '—')}</td>
          <td><strong>${esc(r.headcount || '0')}</strong></td>
          <td style="font-weight:600;">${esc(r.client || 'Untitled')}</td>
          <td>${fmtDate(r.terminationDate)}</td>
          <td style="max-width:220px;white-space:normal;">${esc(r.reason || '—')}</td>
          <td><span class="stagepill-table stage-${r.status || 'requested'}">${stageLabelOf(r.status || 'requested')}</span></td>
        </tr>
      `).join('');

    } else { // open_enrollment - FULL OE EXCEL TRACKER

      tableHeadersHtml = `
        <tr>
          <th>S.No</th>
          <th>OE Renewal Doc Receive / Received Date</th>
          <th>Client</th>
          <th>CRM</th>
          <th>Config Analyst</th>
          <th>OE Type</th>
          <th>Sort By OE Start Date - 1 Blackout</th>
          <th>OE End Date (EE)</th>
          <th>OE End Date (HR)</th>
          <th>OE Effective</th>
          <th>Type of OE</th>
          <th>Plans with Active OE</th>
          <th>Plans with Passive OE</th>
          <th>OE Setup Status</th>
          <th>Review/Testing Status</th>
          <th>Finalization Rules Status</th>
          <th>Announcement Email to be Sent By</th>
          <th>Reminder Emails Frequency</th>
          <th>OE Closure</th>
          <th>OE Finalization Date</th>
          <th>HGS Comments</th>
        </tr>
      `;

      tableRowsHtml = displayRecords.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtDate(r.oeDocReceivedDate || r.oeRenewalDocReceivedDate || r.renewalDocReceivedDate)}</td>
          <td style="font-weight:600;">${esc(r.client || '—')}</td>
          <td>${esc(r.crm || r.crmName || r.implementationManager || '—')}</td>
          <td>${esc(r.configAnalyst || '—')}</td>
          <td>
            <span style="font-size:10px;font-weight:700;padding:3px 7px;border-radius:5px;background:#e0f2fe;color:#0369a1;white-space:nowrap;">
              ${esc(r.oeType || '—')}
            </span>
          </td>
          <td>${fmtDate(r.oeStartDateBlackout || r.sortByOeStartDate || r.oeStartDate || r.blackoutDate)}</td>
          <td>${fmtDate(r.oeEndDateEE || r.oeEndDate || r.oeEndDateEe)}</td>
          <td>${fmtDate(r.oeEndDateHR || r.oeEndDateHr)}</td>
          <td>${fmtDate(r.oeEffective || r.oeEffectiveDate)}</td>
          <td>${esc(r.typeOfOe || r.typeOfOE || r.enrollmentType || '—')}</td>
          <td><strong>${esc(r.activePlans || '0')}</strong></td>
          <td><strong>${esc(r.passivePlans || '0')}</strong></td>
          <td>${esc(r.setupStatus || '—')}</td>
          <td>${esc(r.reviewTestingStatus || r.testingStatus || '—')}</td>
          <td>${esc(r.finalizationRulesStatus || r.finalizationStatus || '—')}</td>
          <td>${fmtDate(r.announcementEmailSentBy || r.announcementEmailDate)}</td>
          <td>${esc(r.reminderEmailsFrequency || r.reminderFrequency || '—')}</td>
          <td>${esc(r.oeClosure || r.oeClosureStatus || '—')}</td>
          <td>${fmtDate(r.oeFinalizationDate || r.finalizationDate)}</td>
          <td style="min-width:220px;max-width:300px;white-space:normal;">${esc(r.comments || r.hgsComments || '—')}</td>
        </tr>
      `).join('');
    }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <h3 style="margin:0;font-family:'Space Grotesk',sans-serif;font-size:18px;">${typeLabelOf(moduleType)} Excel Master Report</h3>
            <div class="hint">Contains all original spreadsheet headers (${displayRecords.length} of ${records.length} active records)</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <label class="btn btn-ghost" id="btn-import-excel-label" style="cursor:pointer;display:flex;align-items:center;gap:6px;">
              📤 Upload Excel (.xlsx)
              <input type="file" id="btn-import-excel-input" accept=".xlsx,.xls" style="display:none;">
            </label>
            <button class="btn btn-primary" id="btn-export-excel" style="background:#2563eb;">📥 Download Excel Report (.xlsx)</button>
          </div>
        </div>

        <div class="year-filter-row" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--surface-alt);padding:12px 18px;border-radius:12px;border:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12.5px;font-weight:700;color:var(--ink-soft);">📅 Filter Date Field:</span>
            <select id="reports-date-field-select" style="padding:6px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:12.5px;font-weight:600;background:#fff;color:var(--ink);outline:none;cursor:pointer;">
              <option value="any" ${selectedDateField === 'any' ? 'selected' : ''}>Any Date Field</option>
              <option value="received" ${selectedDateField === 'received' ? 'selected' : ''}>Receive / Request Date</option>
              <option value="completed" ${selectedDateField === 'completed' ? 'selected' : ''}>Completion / Effective Date</option>
              <option value="updated" ${selectedDateField === 'updated' ? 'selected' : ''}>Updated / Created Date</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12.5px;font-weight:700;color:var(--ink-soft);">Year:</span>
            <select id="reports-year-select" style="padding:6px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:12.5px;font-weight:600;background:#fff;color:var(--ink);outline:none;cursor:pointer;">
              <option value="all" ${selectedYear === 'all' ? 'selected' : ''}>All Years</option>
              ${years.map(y => `<option value="${y}" ${String(selectedYear) === String(y) ? 'selected' : ''}>${y}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;">
            <div class="year-chip ${selectedYear === 'all' ? 'active' : ''}" data-reports-year="all">All Years</div>
            ${years.map(y => `<div class="year-chip ${String(selectedYear) === String(y) ? 'active' : ''}" data-reports-year="${y}">${y}</div>`).join('')}
          </div>
        </div>

        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:#fff;">
          <table class="data-table">
            <thead>${tableHeadersHtml}</thead>
            <tbody>
              ${tableRowsHtml || `<tr><td colspan="${moduleType === 'crf' ? 22 : moduleType === 'open_enrollment' ? 21 : 8}" style="text-align:center;padding:24px;">No active records found for this filter</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Wire Date Field Select
    const dateSelect = container.querySelector('#reports-date-field-select');
    if (dateSelect) {
      dateSelect.addEventListener('change', () => {
        state.reportsDateFieldFilter[moduleType] = dateSelect.value;
        renderModuleReportsOnly(container, moduleType);
      });
    }

    // Wire Year Select
    const yearSelect = container.querySelector('#reports-year-select');
    if (yearSelect) {
      yearSelect.addEventListener('change', () => {
        state.reportsYearFilter[moduleType] = yearSelect.value;
        renderModuleReportsOnly(container, moduleType);
      });
    }

    // Wire Year Filter Chips
    container.querySelectorAll('[data-reports-year]').forEach(chip => {
      chip.addEventListener('click', () => {
        state.reportsYearFilter[moduleType] = chip.dataset.reportsYear;
        renderModuleReportsOnly(container, moduleType);
      });
    });

    container.querySelector('#btn-export-excel').addEventListener('click', () => {
      const typeMap = { crf: 'crf', open_enrollment: 'open_enrollment', termination: 'termination', implementation: 'implementation' };
      window.location.href = '/api/export-excel/' + (typeMap[moduleType] || moduleType);
    });

    const importInput = container.querySelector('#btn-import-excel-input');
    if (importInput) {
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const label = container.querySelector('#btn-import-excel-label');
        label.textContent = '⏳ Uploading…';
        const fd = new FormData();
        fd.append('file', file);
        try {
          const res = await fetch('/api/import-excel/' + moduleType, { method: 'POST', body: fd });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Upload failed');
          alert('✅ Upload successful! ' + (result.created || 0) + ' records imported.');
          state.index = await loadIndex();
          renderModuleFrame(container.closest('#main-area'), moduleType);
        } catch (err) {
          alert('❌ Upload failed: ' + err.message);
          label.textContent = '📤 Upload Excel (.xlsx)';
          importInput.value = '';
        }
      });
    }
  }

  // ---------------- Recycle Bin Tab ----------------

  async function renderModuleRecycleBinOnly(container, moduleType) {
    const rawData = await api('/api/tracker/data');
    const key = moduleType === 'crf' ? 'crf' : moduleType === 'termination' ? 'termination' : moduleType === 'implementation' ? 'implementation' : 'open_enrollment';
    const deletedRecords = (rawData[key] || []).filter(r => r.is_deleted);

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <div class="mockup-card" style="padding:20px;border-left:5px solid #ef4444;">
          <div style="font-size:18px;font-weight:700;color:#dc2626;margin-bottom:6px;display:flex;align-items:center;gap:8px;">
            <span>🗑️</span> Recycle Bin (${deletedRecords.length} Deleted Items)
          </div>
          <div class="hint" style="margin-bottom:16px;">Deleted records are retained safely in historical storage with strikethrough styling.</div>

          <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:#fff;">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th><th>Client Name</th><th>Broker</th><th>Original Type</th><th>Status</th><th>Deleted Timestamp</th>
                </tr>
              </thead>
              <tbody>
                ${deletedRecords.map((r, i) => `
                  <tr style="opacity:0.65;text-decoration:line-through;background:#fff5f5;">
                    <td>${i + 1}</td>
                    <td style="font-weight:600;">${esc(r.client || 'Untitled')}</td>
                    <td>${esc(r.broker || '—')}</td>
                    <td>${typeLabelOf(moduleType)}</td>
                    <td><span style="background:#FFDAD6;color:#C00000;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;">DELETED</span></td>
                    <td>${fmtDate(r.updatedAt || r.createdAt)}</td>
                  </tr>
                `).join('') || '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--ink-faint);">Recycle Bin is empty. No deleted records for this module.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
  // ---------------- About Page ----------------

  function renderAbout(main) {
    main.innerHTML = `
      <div style="max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:24px;">
        <div class="home-hero">
          <div class="home-hero-title">About Workforce Junction Platform</div>
          <div class="home-hero-sub">Workforce Junction is an enterprise HR Governance and Benefits Administration solution built to manage Change Requests, Open Enrollment, and Client Onboarding/Offboarding end to end.</div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;">
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;color:var(--accent);margin-bottom:8px;">📄 Change Request Forms (CRF)</div>
            <div style="font-size:13px;color:var(--ink-soft);line-height:1.6;">Full lifecycle management for benefit plan changes, client setups, and system enhancements. Tracks configuration vs testing hours and analyst ownership.</div>
          </div>
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;color:#3b82f6;margin-bottom:8px;">📅 Open Enrollment (OE)</div>
            <div style="font-size:13px;color:var(--ink-soft);line-height:1.6;">Streamlines annual benefit plan renewals. Supports active and passive plan configurations, broker assignments, and start-date milestones.</div>
          </div>
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;color:#10b981;margin-bottom:8px;">👥 Client Implementation</div>
            <div style="font-size:13px;color:var(--ink-soft);line-height:1.6;">Onboarding task checklist for new clients. Tracks Design Guide receipt dates, target Go-Live dates, and total covered EE headcounts.</div>
          </div>
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;color:#ef4444;margin-bottom:8px;">👤 Client Termination</div>
            <div style="font-size:13px;color:var(--ink-soft);line-height:1.6;">Compliance-focused offboarding workflow. Secures cross-team sign-offs, data retention schedules, and termination reason tracking.</div>
          </div>
        </div>

        <div class="mockup-card" style="padding:24px;">
          <h3 style="margin-top:0;font-family:'Space Grotesk',sans-serif;font-size:18px;">Key Platform Features</h3>
          <ul style="margin:0;padding-left:20px;font-size:13.5px;color:var(--ink-soft);line-height:1.8;">
            <li><strong>Live Excel Sync:</strong> All records are automatically written to background Excel workbooks without losing historical changes.</li>
            <li><strong>Audit &amp; Recycle Bin:</strong> Deleted records are preserved safely in the Recycle Bin with full timestamp trace.</li>
            <li><strong>Donut &amp; Line Analytics:</strong> Modern visualizations for category breakdowns, broker distributions, and date-wise trends.</li>
            <li><strong>Responsive Interface:</strong> Optimized for mobile, desktop, and window viewing.</li>
          </ul>
        </div>
      </div>
    `;
  }
  // ---------------- Home ----------------

  function renderHome(main) {
    // Live counts from workspace index
    const totalCount = state.index.length;
    const pendingCount = state.index.filter(x => x.status === 'requested').length;
    const inProgCount = state.index.filter(x => x.status === 'testing' || x.status === 'in_progress' || x.status === 'review').length;
    const approvedCount = state.index.filter(x => x.status === 'approved').length;
    const completedCount = state.index.filter(x => x.status === 'completed').length;
    const crfCount = state.index.filter(x => x.type === 'crf').length;
    const oeCount = state.index.filter(x => x.type === 'open_enrollment').length;
    const termCount = state.index.filter(x => x.type === 'termination').length;
    const implCount = state.index.filter(x => x.type === 'implementation').length;

    const recentActivity = state.index.slice(0, 6);
    const recentNotifs = state.index.filter(x => x.status === 'requested').slice(0, 4);

    const hr = new Date().getHours();
    const greeting = hr < 12 ? 'Good Morning! 👋' : hr < 17 ? 'Good Afternoon! 👋' : 'Good Evening! 👋';

    const clients = [...new Set(state.index.map(r => r.client).filter(Boolean))];
    const brokers = [...new Set(state.index.map(r => r.broker).filter(Boolean))];

    function statusPill(status) {
      const map = {
        requested: { label: 'Requested', bg: '#eff6ff', color: '#2563eb' },
        approved: { label: 'Approved', bg: '#ecfdf5', color: '#059669' },
        testing: { label: 'In Progress', bg: '#fffbeb', color: '#d97706' },
        in_progress: { label: 'In Progress', bg: '#fffbeb', color: '#d97706' },
        review: { label: 'In Review', bg: '#fffbeb', color: '#d97706' },
        completed: { label: 'Completed', bg: '#f5f3ff', color: '#7c3aed' },
      };
      const s = map[status] || { label: status || 'Requested', bg: '#f1f5f9', color: '#64748b' };
      return `<span style="font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:20px;background:${s.bg};color:${s.color};">${s.label}</span>`;
    }

    function moduleIcon(type) {
      if (type === 'crf') return '📄';
      if (type === 'open_enrollment') return '📅';
      if (type === 'termination') return '👤';
      if (type === 'implementation') return '👥';
      return '📋';
    }

    main.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:26px;padding-bottom:32px;">

        <!-- HERO BANNER -->
        <div class="home-hero-banner">
          <div style="flex:1;z-index:1;">
            <div style="font-size:15px;font-weight:600;color:#2563eb;margin-bottom:6px;letter-spacing:0.3px;">${greeting}</div>
            <div style="font-size:32px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.2;margin-bottom:10px;">Welcome to Workforce Junction</div>
            <div style="font-size:14.5px;color:#475569;line-height:1.6;max-width:540px;">Manage Change Requests, Open Enrollment, Terminations and Implementations in one centralized workspace.</div>
            <div style="margin-top:20px;display:flex;align-items:center;gap:12px;">
              <button id="hero-view-tasks-btn" style="background:#2563eb;color:#ffffff;border:none;border-radius:12px;padding:10px 24px;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,0.3);transition:all .2s ease;"
                      onmouseover="this.style.transform='translateY(-2px)'"
                      onmouseout="this.style.transform=''">
                View My Tasks 📋 (${totalCount})
              </button>
            </div>
          </div>
        </div>

        <!-- 5 METRIC CARDS ROW (Clickable to view full details) -->
        <div class="home-metrics-grid">
          <!-- 1. My Tasks -->
          <div class="mockup-card metric-card-btn" data-filter-to="all" style="padding:18px 20px;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
               onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.06)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:42px;height:42px;border-radius:12px;background:#f3e8ff;display:flex;align-items:center;justify-content:center;font-size:18px;color:#7e22ce;flex-shrink:0;">📋</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:#64748b;">My Tasks</div>
                <div style="font-size:24px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.1;">${totalCount}</div>
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:#16a34a;display:flex;align-items:center;gap:4px;">
              <span>↗</span> <span>${totalCount > 0 ? totalCount + ' active records' : '0 active records'}</span>
            </div>
          </div>

          <!-- 2. Pending Approvals -->
          <div class="mockup-card metric-card-btn" data-filter-to="requested" style="padding:18px 20px;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
               onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.06)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:42px;height:42px;border-radius:12px;background:#ffedd5;display:flex;align-items:center;justify-content:center;font-size:18px;color:#c2410c;flex-shrink:0;">⏳</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:#64748b;">Pending Approvals</div>
                <div style="font-size:24px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.1;">${pendingCount}</div>
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:${pendingCount > 0 ? '#ea580c' : '#64748b'};display:flex;align-items:center;gap:4px;">
              <span>${pendingCount > 0 ? '↗' : '✓'}</span> <span>${pendingCount > 0 ? pendingCount + ' awaiting approval' : 'All approved'}</span>
            </div>
          </div>

          <!-- 3. Due Today / Testing -->
          <div class="mockup-card metric-card-btn" data-filter-to="testing" style="padding:18px 20px;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
               onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.06)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:42px;height:42px;border-radius:12px;background:#dbeafe;display:flex;align-items:center;justify-content:center;font-size:18px;color:#1d4ed8;flex-shrink:0;">📅</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:#64748b;">Due Today</div>
                <div style="font-size:24px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.1;">${inProgCount}</div>
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:${inProgCount > 0 ? '#d97706' : '#64748b'};display:flex;align-items:center;gap:4px;">
              <span>${inProgCount > 0 ? '⚡' : '✓'}</span> <span>${inProgCount > 0 ? inProgCount + ' in review / testing' : 'No items due'}</span>
            </div>
          </div>

          <!-- 4. In Progress -->
          <div class="mockup-card metric-card-btn" data-filter-to="approved" style="padding:18px 20px;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
               onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.06)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:42px;height:42px;border-radius:12px;background:#dcfce7;display:flex;align-items:center;justify-content:center;font-size:18px;color:#15803d;flex-shrink:0;">🚀</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:#64748b;">In Progress</div>
                <div style="font-size:24px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.1;">${approvedCount}</div>
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:#16a34a;display:flex;align-items:center;gap:4px;">
              <span>↗</span> <span>${approvedCount > 0 ? (approvedCount) + ' active pipeline' : '0 in progress'}</span>
            </div>
          </div>

          <!-- 5. Completed Today -->
          <div class="mockup-card metric-card-btn" data-filter-to="completed" style="padding:18px 20px;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
               onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.06)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
              <div style="width:42px;height:42px;border-radius:12px;background:#fef3c7;display:flex;align-items:center;justify-content:center;font-size:18px;color:#b45309;flex-shrink:0;">🏁</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:#64748b;">Completed Tasks</div>
                <div style="font-size:24px;font-weight:800;color:#1e293b;font-family:'Space Grotesk',sans-serif;line-height:1.1;">${completedCount}</div>
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:#7c3aed;display:flex;align-items:center;gap:4px;">
              <span>✓</span> <span>${completedCount > 0 ? completedCount + ' completed' : '0 completed'}</span>
            </div>
          </div>
        </div>

        <!-- 4 WORKSPACES MODULE ROW -->
        <div>
          <div style="font-size:17px;font-weight:700;color:#1e293b;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
            <span>💼 Workspaces</span>
            <span style="font-size:12px;font-weight:600;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:12px;">4 Active Modules</span>
          </div>
          <div class="home-workspaces-grid">
            <!-- CRF Card -->
            <div class="mockup-card" style="padding:22px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
                 onclick="openModule('crf')"
                 onmouseover="this.style.transform='translateY(-3px)';this.style.borderColor='#2563eb';this.style.boxShadow='0 10px 25px rgba(37,99,235,0.1)'"
                 onmouseout="this.style.transform='';this.style.borderColor='#e2e8f0';this.style.boxShadow=''">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="width:48px;height:48px;border-radius:14px;background:#eff6ff;display:flex;align-items:center;justify-content:center;font-size:22px;color:#2563eb;">📄</div>
                <span style="font-size:12px;font-weight:700;color:#2563eb;background:#eff6ff;padding:4px 10px;border-radius:20px;">${crfCount} Items</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:6px;">Change Requests</div>
              <div style="font-size:13px;color:#64748b;line-height:1.5;">CRF form submissions, plan config updates, &amp; testing</div>
            </div>

            <!-- Open Enrollment Card -->
            <div class="mockup-card" style="padding:22px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
                 onclick="openModule('open_enrollment')"
                 onmouseover="this.style.transform='translateY(-3px)';this.style.borderColor='#059669';this.style.boxShadow='0 10px 25px rgba(5,150,105,0.1)'"
                 onmouseout="this.style.transform='';this.style.borderColor='#e2e8f0';this.style.boxShadow=''">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="width:48px;height:48px;border-radius:14px;background:#ecfdf5;display:flex;align-items:center;justify-content:center;font-size:22px;color:#059669;">📅</div>
                <span style="font-size:12px;font-weight:700;color:#059669;background:#ecfdf5;padding:4px 10px;border-radius:20px;">${oeCount} Items</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:6px;">Open Enrollment</div>
              <div style="font-size:13px;color:#64748b;line-height:1.5;">OE timelines, renewal document logs, &amp; setup status</div>
            </div>

            <!-- Client Termination Card -->
            <div class="mockup-card" style="padding:22px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
                 onclick="openModule('termination')"
                 onmouseover="this.style.transform='translateY(-3px)';this.style.borderColor='#dc2626';this.style.boxShadow='0 10px 25px rgba(220,38,38,0.1)'"
                 onmouseout="this.style.transform='';this.style.borderColor='#e2e8f0';this.style.boxShadow=''">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="width:48px;height:48px;border-radius:14px;background:#fef2f2;display:flex;align-items:center;justify-content:center;font-size:22px;color:#dc2626;">👤</div>
                <span style="font-size:12px;font-weight:700;color:#dc2626;background:#fef2f2;padding:4px 10px;border-radius:20px;">${termCount} Items</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:6px;">Client Termination</div>
              <div style="font-size:13px;color:#64748b;line-height:1.5;">Offboarding checklists, data exports, &amp; closure tasks</div>
            </div>

            <!-- Client Implementation Card -->
            <div class="mockup-card" style="padding:22px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;cursor:pointer;transition:all .2s ease;"
                 onclick="openModule('implementation')"
                 onmouseover="this.style.transform='translateY(-3px)';this.style.borderColor='#7c3aed';this.style.boxShadow='0 10px 25px rgba(124,58,237,0.1)'"
                 onmouseout="this.style.transform='';this.style.borderColor='#e2e8f0';this.style.boxShadow=''">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="width:48px;height:48px;border-radius:14px;background:#f5f3ff;display:flex;align-items:center;justify-content:center;font-size:22px;color:#7c3aed;">👥</div>
                <span style="font-size:12px;font-weight:700;color:#7c3aed;background:#f5f3ff;padding:4px 10px;border-radius:20px;">${implCount} Items</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:6px;">Client Implementation</div>
              <div style="font-size:13px;color:#64748b;line-height:1.5;">New client onboarding, carrier setup, &amp; go-live tracking</div>
            </div>
          </div>
        </div>

        <!-- 3-COLUMN BOTTOM LAYOUT -->
        <div class="home-bottom-grid">

          <!-- LEFT: Recent Activity Table -->
          <div class="mockup-card" style="padding:20px 24px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px;">
              <div style="font-size:16px;font-weight:700;color:#1e293b;">⚡ Recent Submissions</div>
              <button id="view-all-activity-btn" style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer;">View All →</button>
            </div>
            ${recentActivity.length === 0 ? `
              <div style="text-align:center;padding:40px;color:#94a3b8;font-size:13.5px;">No active submissions found.</div>
            ` : `
              <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:440px;">
                  <thead>
                    <tr style="border-bottom:1px solid #e2e8f0;text-align:left;">
                      <th style="padding:10px 12px;color:#64748b;font-weight:600;white-space:nowrap;">Type</th>
                      <th style="padding:10px 12px;color:#64748b;font-weight:600;white-space:nowrap;">Client</th>
                      <th style="padding:10px 12px;color:#64748b;font-weight:600;white-space:nowrap;">Broker</th>
                      <th style="padding:10px 12px;color:#64748b;font-weight:600;white-space:nowrap;">Status</th>
                      <th style="padding:10px 12px;color:#64748b;font-weight:600;text-align:right;white-space:nowrap;">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentActivity.map(r => `
                      <tr data-open="${r.id}" style="border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background .15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                        <td style="padding:10px 12px;white-space:nowrap;">
                          <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#1e293b;">
                            <span>${moduleIcon(r.type)}</span>
                            <span>${typeLabelOf(r.type)}</span>
                          </span>
                        </td>
                        <td style="padding:10px 12px;font-weight:700;color:#0f172a;white-space:nowrap;">${esc(r.client || 'Untitled')}</td>
                        <td style="padding:10px 12px;color:#64748b;white-space:nowrap;">${esc(r.broker || '—')}</td>
                        <td style="padding:10px 12px;white-space:nowrap;">${statusPill(r.status)}</td>
                        <td style="padding:10px 12px;text-align:right;white-space:nowrap;">
                          <button style="font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:6px;border:1px solid #2563eb;background:#eff6ff;color:#2563eb;cursor:pointer;">Open →</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>

          <!-- MIDDLE: At A Glance Stats -->
          <div class="mockup-card" style="padding:24px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;">
            <div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:16px;">📊 At a Glance</div>
            <div style="display:flex;flex-direction:column;gap:14px;">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #f1f5f9;">
                <span style="font-size:13px;font-weight:600;color:#475569;">Active Clients</span>
                <span style="font-size:16px;font-weight:800;color:#2563eb;">${clients.length}</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #f1f5f9;">
                <span style="font-size:13px;font-weight:600;color:#475569;">Broker Partners</span>
                <span style="font-size:16px;font-weight:800;color:#059669;">${brokers.length}</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #f1f5f9;">
                <span style="font-size:13px;font-weight:600;color:#475569;">Pending Approval</span>
                <span style="font-size:16px;font-weight:800;color:#c2410c;">${pendingCount}</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #f1f5f9;">
                <span style="font-size:13px;font-weight:600;color:#475569;">Completed Tasks</span>
                <span style="font-size:16px;font-weight:800;color:#7c3aed;">${completedCount}</span>
              </div>
            </div>
          </div>

          <!-- RIGHT: Recent Notifications -->
          <div class="mockup-card" style="padding:24px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
              <div style="font-size:16px;font-weight:700;color:#1e293b;">🔔 Recent Requests</div>
              <span style="font-size:11.5px;font-weight:700;color:#2563eb;background:#eff6ff;padding:2px 8px;border-radius:10px;">${recentNotifs.length} New</span>
            </div>
            ${recentNotifs.length === 0 ? `
              <div style="text-align:center;padding:30px;color:#94a3b8;font-size:13px;">No new requests</div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:12px;">
                ${recentNotifs.map(r => `
                  <div data-open="${r.id}" style="padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;cursor:pointer;transition:all .15s;" onmouseover="this.style.borderColor='#bfdbfe'" onmouseout="this.style.borderColor='#e2e8f0'">
                    <div style="font-size:13px;font-weight:700;color:#1e293b;">${esc(r.client || 'Untitled')}</div>
                    <div style="font-size:11.5px;color:#64748b;margin-top:2px;">${typeLabelOf(r.type)} &bull; ${fmtDate(r.updatedAt)}</div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>

        </div>

        <!-- FOOTER STRIP -->
        <div style="background:#1e293b;border-radius:18px;padding:20px 28px;color:#ffffff;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">🏢</span>
            <div>
              <div style="font-size:14px;font-weight:700;">Workforce Junction Platform</div>
              <div style="font-size:12px;color:#94a3b8;">Streamlining Employee Benefits Configuration &amp; Administration</div>
            </div>
          </div>
          <div style="display:flex;gap:24px;font-size:12.5px;color:#cbd5e1;">
            <span>⚡ Centralized</span>
            <span>🔒 Efficient</span>
            <span>✅ Accurate</span>
            <span>📊 Insightful</span>
          </div>
        </div>

      </div>
    `;

    // Event listeners for View My Tasks button and Metric Cards
    const tasksBtn = main.querySelector('#hero-view-tasks-btn');
    if (tasksBtn) {
      tasksBtn.addEventListener('click', () => {
        state.trackerViewTab = 'records';
        state.trackerStatusFilter = 'all';
        goView('tracker');
      });
    }

    const viewAllBtn = main.querySelector('#view-all-activity-btn');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => {
        state.trackerViewTab = 'records';
        state.trackerStatusFilter = 'all';
        goView('tracker');
      });
    }

    main.querySelectorAll('.metric-card-btn').forEach(card => {
      card.addEventListener('click', () => {
        const filter = card.dataset.filterTo || 'all';
        state.trackerViewTab = 'records';
        state.trackerStatusFilter = filter;
        goView('tracker');
      });
    });

    // Click on any recent activity table row or notification card opens submission
    main.querySelectorAll('[data-open]').forEach(el => {
      el.addEventListener('click', () => {
        openSubmission(el.dataset.open);
      });
    });
  } function renderDataTableHtml(rows) {
    return `
      <div style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr>
            <th>Type</th><th>Client</th><th>Broker</th><th>Conversation #</th><th>Status</th><th>Progress</th><th>Updated</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr data-open="${r.id}">
                <td><span class="subcard-type ${typeBadgeClass(r.type)}" style="margin:0;">${typeLabelOf(r.type)}</span></td>
                <td>${esc(r.client || 'Untitled')}</td>
                <td>${esc(r.broker) || '—'}</td>
                <td>${esc(r.refConversation) || '—'}</td>
                <td><span class="stagepill-table stage-${r.status || 'requested'}">${stageLabelOf(r.status)}</span></td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                     <div class="progress-track" style="width:70px;height:6px;margin:0;"><div class="progress-fill" style="width:${r.progress ? r.progress.pct : 0}%"></div></div>
                     <span style="font-size:11.5px;color:var(--ink-faint);">${r.progress ? r.progress.pct : 0}%</span>
                  </div>
                </td>
                <td>${fmtDate(r.updatedAt)}</td>
                <td><button class="task-del" title="Delete submission" data-del="${r.id}">&#128465;</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }


  // ---- Chart Helper Functions (SVG) ----

  function buildTimelineSvg(dataRows, W, H, dateFilter = '30d') {
    const PAD_L = 42, PAD_R = 32, PAD_T = 22, PAD_B = 30;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    if (!dataRows.length) return `<svg width="${W}" height="${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#94a3b8" font-size="13" font-weight="600">No data available</text></svg>`;

    const now = new Date(); const buckets = {};
    let isMonthly = false;
    let daysToLookBack = 30;

    if (dateFilter === '7d') daysToLookBack = 7;
    else if (dateFilter === '30d') daysToLookBack = 30;
    else if (dateFilter === '90d') daysToLookBack = 90;
    else if (dateFilter === '12m') {
      isMonthly = true;
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')] = 0;
      }
    } else if (dateFilter === 'ytd') {
      isMonthly = true;
      for (let i = 0; i <= now.getMonth(); i++) {
        const d = new Date(now.getFullYear(), i, 1);
        buckets[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')] = 0;
      }
    }

    if (!isMonthly) {
      for (let i = daysToLookBack - 1; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        buckets[d.toISOString().slice(0, 10)] = 0;
      }
    }

    dataRows.forEach(r => {
      const dt = new Date(r.updatedAt || r.createdAt || r.created_at || now);
      if (isMonthly) {
        const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
        if (buckets.hasOwnProperty(key)) buckets[key]++;
      } else {
        const key = dt.toISOString().slice(0, 10);
        if (buckets.hasOwnProperty(key)) buckets[key]++;
      }
    });

    const keys = Object.keys(buckets).sort();
    const vals = keys.map(k => buckets[k]);
    const maxVal = Math.max(...vals);
    const maxV = Math.max(4, Math.ceil(maxVal * 1.25));
    const total = vals.reduce((a, b) => a + b, 0);

    const coords = vals.map((v, i) => {
      const x = PAD_L + (i / Math.max(1, vals.length - 1)) * cW;
      const y = PAD_T + cH - (v / maxV) * cH;
      return { x, y, v };
    });

    // Smooth Bézier curve generator
    // Clean straight-line chart path.
    // Straight segments prevent curve overshoot and distortion.
    const linePath = coords.length
      ? coords.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`
      ).join(' ')
      : '';

    const areaPath = linePath
      ? `${linePath}
        L ${(PAD_L + cW).toFixed(1)},${(PAD_T + cH).toFixed(1)}
        L ${PAD_L.toFixed(1)},${(PAD_T + cH).toFixed(1)}
        Z`
      : '';

    const yTicks = 4;
    const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
      const v = Math.round((maxV / yTicks) * i);
      const y = PAD_T + cH - (i / yTicks) * cH;
      return `<text x="${PAD_L - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="11.5" font-weight="500" font-family="'Inter', sans-serif">${v}</text>
              <line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(PAD_L + cW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="4 4"/>`;
    }).join('');

    const step = Math.max(1, Math.floor(keys.length / 6));
    const xLabels = keys.filter((_, i) => isMonthly || i % step === 0 || i === keys.length - 1).map(k => {
      const idx = keys.indexOf(k);
      const x = PAD_L + (idx / Math.max(1, keys.length - 1)) * cW;

      let anchor = 'middle';
      if (idx === 0) anchor = 'start';
      else if (idx === keys.length - 1) anchor = 'end';

      let lbl;
      if (isMonthly) {
        const [yy, mm] = k.split('-');
        const d = new Date(parseInt(yy), parseInt(mm) - 1, 1);
        lbl = d.toLocaleDateString(undefined, { month: 'short' });
      } else {
        const d = new Date(k + 'T12:00:00Z');
        lbl = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
      return `<text x="${x.toFixed(1)}" y="${(PAD_T + cH + 22).toFixed(1)}" text-anchor="${anchor}" fill="#64748b" font-size="9.5" font-weight="500" font-family="'Inter', sans-serif">${lbl}</text>`;
    }).join('');

    const dots = coords.map((pt, i) => {
      if (pt.v === 0) return '';
      return `
        <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>
        <rect x="${(pt.x - 11).toFixed(1)}" y="${(pt.y - 23).toFixed(1)}" width="22" height="17" rx="5" fill="#1e293b" opacity="0.9"/>
        <text x="${pt.x.toFixed(1)}" y="${(pt.y - 10.5).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-size="10.5" font-weight="600" font-family="'Inter', sans-serif">${pt.v}</text>
      `;
    }).join('');

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible;">
      <defs>
        <linearGradient id="smoothLineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${yLabels}
      ${xLabels}
      ${areaPath ? `<path d="${areaPath}" fill="url(#smoothLineGrad)"/>` : ''}
      ${linePath ? `
  <path
    d="${linePath}"
    fill="none"
    stroke="#2563eb"
    stroke-width="1.5"
    stroke-linejoin="round"
    stroke-linecap="round"
  />
` : ''}
      ${dots}
    </svg>`;
  }

  function buildDonutSvg(slices, size) {
    const R = size / 2 - 10, cx = size / 2, cy = size / 2;
    const innerR = R * 0.58;
    const total = slices.reduce((s, sl) => s + sl.value, 0);
    if (total === 0) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:100%;max-width:${size}px;height:auto;">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="#f1f5f9" stroke="white" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="white"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" dominant-baseline="middle" fill="#999" font-size="13">No data</text>
    </svg>`;

    const active = slices.filter(s => s.value > 0);

    let arcs = '';
    if (active.length === 1) {
      arcs = `<circle cx="${cx}" cy="${cy}" r="${(R + innerR) / 2}" fill="none" stroke="${active[0].color}" stroke-width="${R - innerR}" />`;
    } else {
      let cumAngle = -Math.PI / 2;
      arcs = active.map(sl => {
        const frac = sl.value / total;
        const startAngle = cumAngle;
        const endAngle = cumAngle + frac * 2 * Math.PI - 0.01;
        cumAngle += frac * 2 * Math.PI;
        const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
        const ox1 = cx + R * Math.cos(startAngle), oy1 = cy + R * Math.sin(startAngle);
        const ox2 = cx + R * Math.cos(endAngle), oy2 = cy + R * Math.sin(endAngle);
        const ix1 = cx + innerR * Math.cos(endAngle), iy1 = cy + innerR * Math.sin(endAngle);
        const ix2 = cx + innerR * Math.cos(startAngle), iy2 = cy + innerR * Math.sin(startAngle);
        return `<path d="M${ox1.toFixed(2)},${oy1.toFixed(2)} A${R},${R} 0 ${largeArc} 1 ${ox2.toFixed(2)},${oy2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${innerR},${innerR} 0 ${largeArc} 0 ${ix2.toFixed(2)},${iy2.toFixed(2)} Z" fill="${sl.color}" stroke="white" stroke-width="1.5"/>`;
      }).join('');
    }

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:100%;max-width:${size}px;height:auto;">
      ${arcs}
      <circle cx="${cx}" cy="${cy}" r="${innerR - 2}" fill="white"/>
      <text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="#1e293b" font-size="21" font-weight="800">${total}</text>
      <text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="#94a3b8" font-size="10">Records</text>
    </svg>`;
  }

  function buildKpiRingSvg(value, text1, text2, color, size = 120, ringWidth = 14) {
    const R = size / 2 - ringWidth / 2, cx = size / 2, cy = size / 2;
    const displayVal = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(1) : value;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="max-width:${size}px;">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${color}" stroke-width="${ringWidth}" />
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" dominant-baseline="middle" fill="#1e293b" font-size="24" font-weight="700" font-family="'Space Grotesk', sans-serif">${displayVal}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" dominant-baseline="middle" fill="#1e293b" font-size="12" font-weight="600">${text1}</text>
      ${text2 ? `<text x="${cx}" y="${cy + 34}" text-anchor="middle" dominant-baseline="middle" fill="#64748b" font-size="11">${text2}</text>` : ''}
    </svg>`;
  }

  function buildDetailedDonutSvg(slices, size, centerLabel, centerValue) {
    const R = size / 2 - 12, cx = size / 2, cy = size / 2;
    const innerR = R * 0.55;
    const total = slices.reduce((s, sl) => s + sl.value, 0);
    if (total === 0) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${R}" fill="#f1f5f9" stroke="white" stroke-width="2"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="#999" font-size="13">No data</text></svg>`;

    const uid = 'donut_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const active = slices.filter(s => s.value > 0);
    let arcs = '';
    let labels = '';
    if (active.length === 1) {
      arcs = `<circle cx="${cx}" cy="${cy}" r="${(R + innerR) / 2}" fill="none" stroke="${active[0].color}" stroke-width="${R - innerR}" class="donut-slice-hover" data-donut-tip="${active[0].label}: ${active[0].displayVal || active[0].value} (100%)" style="cursor:pointer;" />`;
      labels = `<text x="${cx}" y="${cy - (R + innerR) / 2}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="12" font-weight="600" pointer-events="none">100%</text>`;
    } else {
      let cumAngle = -Math.PI / 2;
      arcs = active.map(sl => {
        const frac = sl.value / total;
        const startAngle = cumAngle;
        const endAngle = cumAngle + frac * 2 * Math.PI - 0.01;
        cumAngle += frac * 2 * Math.PI;
        const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
        const ox1 = cx + R * Math.cos(startAngle), oy1 = cy + R * Math.sin(startAngle);
        const ox2 = cx + R * Math.cos(endAngle), oy2 = cy + R * Math.sin(endAngle);
        const ix1 = cx + innerR * Math.cos(endAngle), iy1 = cy + innerR * Math.sin(endAngle);
        const ix2 = cx + innerR * Math.cos(startAngle), iy2 = cy + innerR * Math.sin(startAngle);

        const midAngle = startAngle + (endAngle - startAngle) / 2;
        const labelR = (R + innerR) / 2;
        const lx = cx + labelR * Math.cos(midAngle);
        const ly = cy + labelR * Math.sin(midAngle);

        if (frac >= 0.05) {
          labels += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="11" font-weight="600" pointer-events="none">${Math.round(frac * 100)}%</text>`;
        }
        return `<path d="M${ox1.toFixed(2)},${oy1.toFixed(2)} A${R},${R} 0 ${largeArc} 1 ${ox2.toFixed(2)},${oy2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${innerR},${innerR} 0 ${largeArc} 0 ${ix2.toFixed(2)},${iy2.toFixed(2)} Z" fill="${sl.color}" stroke="white" stroke-width="1.5" class="donut-slice-hover" data-donut-tip="${sl.label}: ${sl.displayVal || sl.value} (${Math.round(frac * 100)}%)" style="cursor:pointer;"/>`;
      }).join('');
    }

    const lines = (centerLabel || '').split('\n');
    let labelSvg = '';
    if (lines.length > 1) {
      labelSvg = `<text x="${cx}" y="${cy - 14}" text-anchor="middle" fill="#64748b" font-size="11" font-weight="600">
        <tspan x="${cx}" dy="0">${esc(lines[0])}</tspan>
        <tspan x="${cx}" dy="13">${esc(lines[1])}</tspan>
      </text>`;
    } else {
      labelSvg = `<text x="${cx}" y="${cy - 10}" text-anchor="middle" fill="#64748b" font-size="12" font-weight="600">${esc(centerLabel)}</text>`;
    }

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" data-donut-id="${uid}">
      ${arcs}
      ${labels}
      ${labelSvg}
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#1e293b" font-size="22" font-weight="800" font-family="'Space Grotesk', sans-serif">${centerValue}</text>
    </svg>`;
  }
  function setupDonutTooltips(container) {
    let tip = document.getElementById('donut-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'donut-tooltip';
      tip.className = 'chart-tooltip';
      document.body.appendChild(tip);
    }
    container.querySelectorAll('.donut-slice-hover').forEach(el => {
      el.addEventListener('mouseenter', (e) => {
        const text = el.getAttribute('data-donut-tip');
        if (!text) return;
        tip.textContent = text;
        tip.style.display = 'block';
        const rect = el.getBoundingClientRect();
        tip.style.left = (rect.left + rect.width / 2) + 'px';
        tip.style.top = (rect.top - 8) + 'px';
      });
      el.addEventListener('mousemove', (e) => {
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = (e.clientY - 28) + 'px';
      });
      el.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
      });
    });
  }


  async function renderTracker(main) {
    const tab = state.trackerViewTab || 'analytics';

    // Render tab switcher header
    main.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
        <div>
          <h2 style="margin:0;font-family:'Space Grotesk',sans-serif;font-size:22px;">Tracker &amp; Analytics</h2>
          <div class="hint">Live workspace data from your tracking records</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="tab-btn-analytics" style="padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:${tab === 'analytics' ? 'var(--accent)' : 'var(--surface)'};color:${tab === 'analytics' ? '#fff' : 'var(--ink-soft)'};">📊 Analytics</button>
          <button id="tab-btn-records" style="padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:${tab === 'records' ? 'var(--accent)' : 'var(--surface)'};color:${tab === 'records' ? '#fff' : 'var(--ink-soft)'};">📋 Records</button>
        </div>
      </div>
      <div id="tracker-content-area"></div>
    `;

    main.querySelector('#tab-btn-analytics').addEventListener('click', () => {
      state.trackerViewTab = 'analytics';
      renderTracker(main);
    });
    main.querySelector('#tab-btn-records').addEventListener('click', () => {
      state.trackerViewTab = 'records';
      renderTracker(main);
    });

    const contentArea = main.querySelector('#tracker-content-area');

    if (tab === 'records') {
      await renderTrackerTable(contentArea);
      return;
    }

    // ---- ANALYTICS TAB ----
    contentArea.innerHTML = `<div style="display:flex;justify-content:center;padding:60px;"><div class="spinner"></div></div>`;

    state.index = await loadIndex();
    const allRows = state.index;
    const df = state.analyticsDateFilter || 'all';

    const datePickerHtml = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
        <span style="font-size:12px;font-weight:600;color:var(--ink-soft);">Time period:</span>
        <div class="filter-row" style="margin:0;">
          <div class="chip ${df === 'all' ? 'active' : ''}" data-date-filter="all">All Time</div>
          <div class="chip ${df === '7d' ? 'active' : ''}" data-date-filter="7d">Last 7 Days</div>
          <div class="chip ${df === '30d' ? 'active' : ''}" data-date-filter="30d">Last 30 Days</div>
          <div class="chip ${df === '90d' ? 'active' : ''}" data-date-filter="90d">Last 90 Days</div>
          <div class="chip ${df === 'ytd' ? 'active' : ''}" data-date-filter="ytd">YTD</div>
          <div class="chip ${df === '12m' ? 'active' : ''}" data-date-filter="12m">12 Months</div>
        </div>
      </div>
    `;

    const now = new Date();
    const rows = allRows.filter(r => {
      const d = new Date(r.updatedAt || r.created_at || now);
      if (df === '7d' && (now - d) > 7 * 86400000) return false;
      if (df === '30d' && (now - d) > 30 * 86400000) return false;
      if (df === '90d' && (now - d) > 90 * 86400000) return false;
      if (df === 'ytd' && d.getFullYear() !== now.getFullYear()) return false;
      if (df === '12m' && (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth() >= 12) return false;
      return true;
    });

    const crf = rows.filter(r => r.type === 'crf');
    const impl = rows.filter(r => r.type === 'implementation');
    const term = rows.filter(r => r.type === 'termination');
    const oe = rows.filter(r => r.type === 'open_enrollment');

    // 1. CRF Aggregation
    const crfCat = { 'Plan Configuration': 0, 'Client Setup': 0, 'Benefit Changes': 0, 'System Enhancement': 0, 'Other': 0 };
    let crfTimeConfig = 0, crfTimeTesting = 0;
    const reqByCount = {}, configAnalystCount = {}, testingAnalystCount = {}, implManagerCount = {}, clientCount = {}, partnerCount = {};
    crf.forEach(r => {
      const cat = r.category || 'Other';
      if (crfCat.hasOwnProperty(cat)) crfCat[cat]++; else crfCat['Other']++;
      crfTimeConfig += (parseFloat(r.timeConfig) || parseFloat(r.timeConfiguration) || 0);
      crfTimeTesting += (parseFloat(r.timeTesting) || parseFloat(r.timeReviewTesting) || 0);
      if (r.requestedBy) reqByCount[r.requestedBy] = (reqByCount[r.requestedBy] || 0) + 1;
      if (r.configAnalyst) configAnalystCount[r.configAnalyst] = (configAnalystCount[r.configAnalyst] || 0) + 1;
      if (r.testingAnalyst) testingAnalystCount[r.testingAnalyst] = (testingAnalystCount[r.testingAnalyst] || 0) + 1;
      if (r.implementationManager) implManagerCount[r.implementationManager] = (implManagerCount[r.implementationManager] || 0) + 1;
      if (r.client) clientCount[r.client] = (clientCount[r.client] || 0) + 1;
      if (r.broker) partnerCount[r.broker] = (partnerCount[r.broker] || 0) + 1;
    });

    const crfDonut = [
      { label: 'Plan Configuration', value: crfCat['Plan Configuration'] || 0, color: '#2563eb' },
      { label: 'Client Setup', value: crfCat['Client Setup'] || 0, color: '#10b981' },
      { label: 'Benefit Changes', value: crfCat['Benefit Changes'] || 0, color: '#f59e0b' },
      { label: 'System Enhancement', value: crfCat['System Enhancement'] || 0, color: '#8b5cf6' },
      { label: 'Other', value: crfCat['Other'] || 0, color: '#06b6d4' }
    ];
    const crfTotal = crf.length;
    const crfTc = crfTimeConfig || 0, crfTt = crfTimeTesting || 0;

    // CRF Monthly Bar
    const crfMonthBuckets = {};
    crf.forEach(r => {
      const d = new Date(r.updatedAt || r.created_at || now);
      const key = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
      crfMonthBuckets[key] = (crfMonthBuckets[key] || 0) + 1;
    });
    const crfMonths = Object.keys(crfMonthBuckets).slice(-6);

    // 2. Implementation Aggregation
    const implBrokerMap = {}, implClientMap = {};
    let implHeadcountTotal = 0;
    const implMonthBuckets = {};
    impl.forEach(r => {
      if (r.broker) implBrokerMap[r.broker] = (implBrokerMap[r.broker] || 0) + 1;
      if (r.client) implClientMap[r.client] = (implClientMap[r.client] || 0) + 1;
      implHeadcountTotal += (r.headcount || 0);
      const d = new Date(r.updatedAt || r.created_at || now);
      const key = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
      implMonthBuckets[key] = (implMonthBuckets[key] || 0) + 1;
    });
    const implBrokerNames = Object.keys(implBrokerMap);
    const implDonut = [
      { label: 'Clients', value: Object.keys(implClientMap).length || 0, color: '#10b981' },
      { label: 'Broker', value: implBrokerNames.length || 0, color: '#34d399' },
      { label: 'EE Headcount', value: Math.max(1, Math.round((implHeadcountTotal || 0) / 100) || 0), displayVal: (implHeadcountTotal || 0).toLocaleString(), color: '#a7f3d0' }
    ];
    const implTotal = impl.length;
    const implMonths = Object.keys(implMonthBuckets).slice(-6);

    // 3. Termination Aggregation
    const termBrokerMap = {}, termClientMap = {};
    let termHeadcountTotal = 0;
    const termMonthBuckets = {};
    term.forEach(r => {
      if (r.broker) termBrokerMap[r.broker] = (termBrokerMap[r.broker] || 0) + 1;
      if (r.client) termClientMap[r.client] = (termClientMap[r.client] || 0) + 1;
      termHeadcountTotal += (r.headcount || 0);
      const d = new Date(r.updatedAt || r.created_at || now);
      const key = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
      termMonthBuckets[key] = (termMonthBuckets[key] || 0) + 1;
    });
    const termBrokerNames = Object.keys(termBrokerMap);
    const termDonut = [
      { label: 'Clients', value: Object.keys(termClientMap).length || 0, color: '#ef4444' },
      { label: 'Broker', value: termBrokerNames.length || 0, color: '#f87171' },
      { label: 'EE Headcount', value: Math.max(1, Math.round((termHeadcountTotal || 0) / 100) || 0), displayVal: (termHeadcountTotal || 0).toLocaleString(), color: '#fca5a5' }
    ];
    const termTotal = term.length;
    const termMonths = Object.keys(termMonthBuckets).slice(-6);

    // 4. OE Aggregation
    const oeTypeMap = {}, oeAnalystMap = {}, oeClientMap = {};
    let oeActive = 0, oePassive = 0;
    const oeMonthBuckets = {};
    oe.forEach(r => {
      if (r.typeOfOe) oeTypeMap[r.typeOfOe] = (oeTypeMap[r.typeOfOe] || 0) + 1;
      if (r.configAnalyst) oeAnalystMap[r.configAnalyst] = (oeAnalystMap[r.configAnalyst] || 0) + 1;
      if (r.client) oeClientMap[r.client] = (oeClientMap[r.client] || 0) + 1;
      oeActive += (r.activePlans || 0);
      oePassive += (r.passivePlans || 0);
      const d = new Date(r.updatedAt || r.created_at || now);
      const key = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
      oeMonthBuckets[key] = (oeMonthBuckets[key] || 0) + 1;
    });
    const oeDonut = [
      { label: 'Client', value: Object.keys(oeClientMap).length || 0, color: '#2563eb' },
      { label: 'Config Analyst', value: Object.keys(oeAnalystMap).length || 0, color: '#06b6d4' },
      { label: 'OE Type', value: Object.keys(oeTypeMap).length || 0, color: '#10b981' },
      { label: 'Plans with Active OE', value: oeActive || 0, color: '#f59e0b' },
      { label: 'Plans with Passive OE', value: oePassive || 0, color: '#8b5cf6' }
    ];
    const oeTotal = oe.length;
    const oeMonths = Object.keys(oeMonthBuckets).slice(-6);

    function donutLegendRows(slices) {
      const tot = slices.reduce((s, x) => s + x.value, 0) || 1;
      return slices.map(s => `
        <div class="donut-legend-item">
          <span class="kpi-legend-dot" style="background:${s.color};"></span>
          <span style="font-size:12px;flex:1;">${s.label}</span>
          <span class="val" style="font-size:12px;">${s.displayVal || s.value} <span style="font-size:10px;color:#94a3b8;">(${Math.round(s.value / tot * 100)}%)</span></span>
        </div>
      `).join('');
    }

    function miniBarChart(buckets, color, keys) {
      if (!keys || keys.length === 0) return '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:24px;font-weight:600;">No monthly records yet</div>';
      const vals = keys.map(k => buckets[k] || 0);
      const maxV = Math.max(4, ...vals);
      return `<div style="display:flex;align-items:flex-end;justify-content:center;gap:16px;height:110px;padding:12px 16px 0;background:#f8fafc;border-radius:14px;border:1px solid #f1f5f9;">
        ${keys.map((k, i) => {
        const barH = Math.max(vals[i] > 0 ? 14 : 4, Math.round((vals[i] / maxV) * 65));
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;min-width:54px;">
            <div style="font-size:11px;font-weight:800;color:${color};background:#ffffff;padding:2px 8px;border-radius:10px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.04);">${vals[i]}</div>
            <div style="width:36px;background:linear-gradient(180deg, ${color} 0%, #1d4ed8 100%);border-radius:6px 6px 0 0;height:${barH}px;transition:all .3s ease;box-shadow:0 2px 8px rgba(37,99,235,0.15);"></div>
            <div style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap;margin-top:2px;">${k}</div>
          </div>`;
      }).join('')}
      </div>`;
    }

    function hBarChart(counts, color, maxItems) {
      const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, maxItems || 6);
      if (entries.length === 0) return '<div style="color:#94a3b8;font-size:12.5px;text-align:center;padding:18px;font-weight:600;">No data yet</div>';
      const maxV = Math.max(1, ...entries.map(e => e[1]));
      return `<div style="display:flex;flex-direction:column;gap:9px;">
        ${entries.map(([name, val]) => {
        const pct = Math.max(6, Math.round((val / maxV) * 100));
        return `<div style="display:flex;align-items:center;gap:8px;">
            <div style="width:118px;flex-shrink:0;font-size:11.5px;font-weight:600;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(name)}">${esc(name)}</div>
            <div style="flex:1;background:#f1f5f9;border-radius:6px;height:15px;position:relative;overflow:hidden;">
              <div style="width:${pct}%;height:100%;background:linear-gradient(90deg, ${color} 0%, ${color} 100%);border-radius:6px;"></div>
            </div>
            <div style="width:22px;flex-shrink:0;font-size:11.5px;font-weight:800;color:${color};text-align:right;">${val}</div>
          </div>`;
      }).join('')}
      </div>`;
    }

    const analyticsHtml = `
      <div style="display:flex;flex-direction:column;gap:20px;">

        <!-- CRF Card -->
        <div class="mockup-card" style="padding:24px;">
          <div style="font-size:20px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;text-align:center;margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:10px;">
            <span style="color:#2563eb;">📄</span> Change Request Forms
          </div>
          <div style="display:flex;align-items:stretch;gap:24px;flex-wrap:wrap;">
            <!-- Donut + legend -->
            <div style="flex:1;display:flex;align-items:center;gap:18px;justify-content:center;min-width:280px;border-right:1px solid #f1f5f9;padding-right:24px;">
              ${buildDetailedDonutSvg(crfDonut, 190, 'Total', crfTotal)}
              <div class="donut-legend-right" style="min-width:170px;">
                <div style="font-size:12.5px;font-weight:700;color:#1e293b;margin-bottom:8px;">By Category</div>
                ${donutLegendRows(crfDonut)}
              </div>
            </div>
            <!-- KPI Rings -->
            <div style="flex:1.6;display:flex;align-items:center;justify-content:space-around;flex-wrap:wrap;gap:12px;min-width:280px;">
              <div class="kpi-ring-container"><div class="kpi-ring-title">Time Spent on<br>Configuration<br>(hrs)</div>${buildKpiRingSvg(crfTc, 'hrs', '', '#2563eb', 105)}</div>
              <div class="kpi-ring-container"><div class="kpi-ring-title">Time Spent on<br>Review/Testing<br>(hrs)</div>${buildKpiRingSvg(crfTt, 'hrs', '', '#10b981', 105)}</div>
              <div class="kpi-ring-container"><div class="kpi-ring-title">Total Time<br>(hrs)</div>${buildKpiRingSvg(crfTc + crfTt, 'hrs', '', '#8b5cf6', 105)}</div>
              <div class="kpi-ring-container"><div class="kpi-ring-title">Requests by<br>Requested By</div>${buildKpiRingSvg(Object.keys(reqByCount).length || crfTotal, 'Total', '', '#06b6d4', 105)}</div>
            </div>
          </div>
          
          <!-- Submissions Date-wise Trend Line Chart -->
          <!--<div style="margin-top:20px;padding-top:16px;border-top:1px solid #f8fafc;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div style="font-size:12px;font-weight:700;color:#475569;">📈 Submissions Date-Wise Trend Line Chart</div>
              <div style="font-size:11px;color:#94a3b8;">Total: ${crf.length} requests</div>
            </div>
            ${buildTimelineSvg(crf, 1100, 120)}
          </div> -->

<!-- CRF Monthly Bar -->
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f8fafc;">
            <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;">📅 Monthly Change Requests</div>
            ${miniBarChart(crfMonthBuckets, '#2563eb', crfMonths)}
          </div>
          <!-- Legend -->
          <!-- Breakdown Bar Charts: Requested By, Category, Configuration Analyst, Review/Testing Analyst, Implementation Manager/CRM -->
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f8fafc;">
            <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:12px;">📊 CRF Breakdown</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
              <div style="background:#f8fafc;border:1px solid #f1f5f9;border-radius:14px;padding:14px 16px;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span class="kpi-legend-dot" style="background:#2563eb;"></span> Change Requested By</div>
                ${hBarChart(reqByCount, '#2563eb')}
              </div>
              <div style="background:#f8fafc;border:1px solid #f1f5f9;border-radius:14px;padding:14px 16px;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span class="kpi-legend-dot" style="background:#06b6d4;"></span> Category</div>
                ${hBarChart(crfCat, '#06b6d4')}
              </div>
              <div style="background:#f8fafc;border:1px solid #f1f5f9;border-radius:14px;padding:14px 16px;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span class="kpi-legend-dot" style="background:#2563eb;"></span> Configuration Analyst</div>
                ${hBarChart(configAnalystCount, '#2563eb')}
              </div>
              <div style="background:#f8fafc;border:1px solid #f1f5f9;border-radius:14px;padding:14px 16px;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span class="kpi-legend-dot" style="background:#10b981;"></span> Review/Testing Analyst</div>
                ${hBarChart(testingAnalystCount, '#10b981')}
              </div>
              <div style="background:#f8fafc;border:1px solid #f1f5f9;border-radius:14px;padding:14px 16px;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span class="kpi-legend-dot" style="background:#8b5cf6;"></span> Implementation Manager/CRM</div>
                ${hBarChart(implManagerCount, '#8b5cf6')}
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom 3 Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;">

          <!-- Clients Implemented -->
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;padding-bottom:8px;border-bottom:2px solid #10b981;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px;">
              <span style="color:#10b981;">👥</span> Clients Implemented
            </div>
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
  ${buildDetailedDonutSvg(implDonut, 140, 'Total', implTotal)}
  <div class="donut-legend-right" style="flex:1;">
    <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:6px;">Clients / Broker / Headcount</div>
    ${donutLegendRows(implDonut)}
  </div>
</div>
            <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">📅 Implementations by Month</div>
            ${miniBarChart(implMonthBuckets, '#10b981', implMonths)}
          </div>

          <!-- Clients Terminated -->
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;padding-bottom:8px;border-bottom:2px solid #ef4444;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px;">
              <span style="color:#ef4444;">👤</span> Clients Terminated
            </div>
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
              ${buildDetailedDonutSvg(termDonut, 140, 'Total', termTotal)}
              <div class="donut-legend-right" style="flex:1;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:6px;">Terminations by Broker</div>
                ${donutLegendRows(termDonut)}
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">📅 Terminations by Month</div>
            ${miniBarChart(termMonthBuckets, '#ef4444', termMonths)}
          </div>

          <!-- Open Enrollment -->
          <div class="mockup-card" style="padding:20px;">
            <div style="font-size:16px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#1e293b;padding-bottom:8px;border-bottom:2px solid #3b82f6;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px;">
              <span style="color:#3b82f6;">📅</span> Open Enrollment
            </div>
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
              ${buildDetailedDonutSvg(oeDonut, 140, 'Total', oeTotal)}
              <div class="donut-legend-right" style="flex:1;">
                <div style="font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:6px;">Active vs. Passive Plans</div>
                ${donutLegendRows(oeDonut)}
              </div>
            </div>
            <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">📅 Monthly OE Requests</div>
            ${miniBarChart(oeMonthBuckets, '#3b82f6', oeMonths)}
          </div>

        </div>

        <div style="font-size:11px;color:#94a3b8;">* All numbers are generated dynamically from live workspace records. Click "Records" tab to see raw data.</div>
      </div>
    `;

    contentArea.innerHTML = datePickerHtml + analyticsHtml;

    contentArea.querySelectorAll('[data-date-filter]').forEach(el => {
      el.addEventListener('click', () => {
        state.analyticsDateFilter = el.dataset.dateFilter;
        renderTracker(main);
      });
    });
    setupDonutTooltips(contentArea);
  }
  function renderList(main, kind) {
    let rows = state.index;
    const showCompletedOnly = (kind === 'completed');

    const typeFilter = showCompletedOnly ? (state.completedTypeFilter || 'all') : (state.listTypeFilter || 'all');
    const statusFilter = showCompletedOnly ? 'completed' : null;
    const search = showCompletedOnly ? (state.completedSearchTerm || '').trim().toLowerCase() : (state.listSearchTerm || '').trim().toLowerCase();

    const listClient = showCompletedOnly ? (state.completedFilterClient || 'all') : (state.listFilterClient || 'all');
    const listBroker = showCompletedOnly ? (state.completedFilterBroker || 'all') : (state.listFilterBroker || 'all');

    if (typeFilter !== 'all') rows = rows.filter(r => r.type === typeFilter);
    if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
    if (listClient !== 'all') rows = rows.filter(r => (r.client || 'Untitled') === listClient);
    if (listBroker !== 'all') rows = rows.filter(r => r.broker === listBroker);
    if (search) {
      rows = rows.filter(r => {
        const client = (r.client || '').toLowerCase();
        const broker = (r.broker || '').toLowerCase();
        const refConv = (r.refConversation || '').toLowerCase();
        const taskText = (r.taskText || '').toLowerCase();
        return client.includes(search) || broker.includes(search) || refConv.includes(search) || taskText.includes(search);
      });
    }

    const title = showCompletedOnly ? 'Completed — browse finished submissions' : 'All Submissions — browse and search every record';

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
        <div>
          <div style="font-weight:700;font-size:20px;font-family:'Space Grotesk',sans-serif;">${title}</div>
          <div class="hint">${rows.length} of ${state.index.length} submission${state.index.length === 1 ? '' : 's'} shown</div>
        </div>
        ${typeFilter !== 'all' ? `
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" id="list-export-btn">&#11015; Download Excel</button>
            <button class="btn btn-ghost btn-sm" id="list-import-btn">&#11014; Upload Excel</button>
            <input type="file" id="list-import-input" accept=".xlsx,.xls" style="display:none;">
          </div>
        ` : ''}
        <button class="btn btn-ghost btn-sm" id="list-delete-all-btn" style="color:var(--c-analytics);">&#128465; Delete All (Filtered)</button>
      </div>

      <div class="search-filter-row" style="display:flex;gap:12px;margin-bottom:14px;align-items:center;flex-wrap:wrap;">
        <div class="search-box-wrapper" style="flex:1;min-width:240px;position:relative;">
          <span style="position:absolute;left:13px;top:50%;transform:translateY(-50%);pointer-events:none;color:#94a3b8;display:flex;align-items:center;z-index:1;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input type="text" id="list-search-input" placeholder="Search by client, broker, conv# or task text…" value="${esc(showCompletedOnly ? state.completedSearchTerm || '' : state.listSearchTerm || '')}" class="list-search-input" style="width:100%;padding:9px 16px 9px 38px;border:1.5px solid var(--border);border-radius:24px;font-size:13px;font-family:'Inter',sans-serif;background:rgba(248,250,252,0.9);color:var(--ink);outline:none;box-shadow:0 1px 4px rgba(0,0,0,0.04);transition:all 0.25s ease;box-sizing:border-box;">
        </div>
        <div class="filter-row" style="margin:0;">
          <div class="chip ${typeFilter === 'all' ? 'active' : ''}" data-type="all">All Types</div>
          <div class="chip ${typeFilter === 'crf' ? 'active' : ''}" data-type="crf">Change Requests</div>
          <div class="chip ${typeFilter === 'termination' ? 'active' : ''}" data-type="termination">Termination</div>
          <div class="chip ${typeFilter === 'implementation' ? 'active' : ''}" data-type="implementation">Implementation</div>
        </div>
        <select id="list-filter-client" class="form-control" style="padding:6px 10px;border-radius:6px;">
          <option value="all">All Clients</option>
          ${[...new Set(state.index.map(r => r.client || 'Untitled'))].sort().map(c => `<option value="${esc(c)}" ${listClient === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select id="list-filter-broker" class="form-control" style="padding:6px 10px;border-radius:6px;">
          <option value="all">All Brokers</option>
          ${[...new Set(state.index.map(r => r.broker).filter(Boolean))].sort().map(b => `<option value="${esc(b)}" ${listBroker === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
        </select>
        ${(typeFilter !== 'all' || search || listClient !== 'all' || listBroker !== 'all') ? `<button class="btn btn-ghost btn-sm" id="list-clear-all-btn" style="color:var(--ink-soft);">Clear All Filters</button>` : ''}
      </div>

      ${typeFilter !== 'all' ? `<div class="hint" style="margin:-8px 0 14px;">Upload/download use your ${typeFilter === 'crf' ? 'CRF Config Master Tracker' : typeFilter === 'implementation' ? 'Clients Implemented' : 'Clients Terminated'} spreadsheet format.</div>` : `<div class="hint" style="margin:-8px 0 14px;">Select a specific type above to enable Download/Upload Excel actions.</div>`}

      ${rows.length === 0 ? `<div class="empty-state">No submissions found matching the criteria.</div>` : renderDataTableHtml(rows)}
    `;

    const searchInp = main.querySelector('#list-search-input');
    searchInp.addEventListener('input', () => {
      if (showCompletedOnly) {
        state.completedSearchTerm = searchInp.value;
      } else {
        state.listSearchTerm = searchInp.value;
      }
      renderList(main, kind);
    });

    main.querySelectorAll('[data-type]').forEach(chip => {
      chip.addEventListener('click', () => {
        if (showCompletedOnly) {
          state.completedTypeFilter = chip.dataset.type;
        } else {
          state.listTypeFilter = chip.dataset.type;
        }
        renderList(main, kind);
      });
    });

    const clearAllBtn = main.querySelector('#list-clear-all-btn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', () => {
        if (showCompletedOnly) {
          state.completedSearchTerm = '';
          state.completedTypeFilter = 'all';
          state.completedFilterClient = 'all';
          state.completedFilterBroker = 'all';
        } else {
          state.listSearchTerm = '';
          state.listTypeFilter = 'all';
          state.listFilterClient = 'all';
          state.listFilterBroker = 'all';
        }
        renderList(main, kind);
      });
    }

    const clientSel = main.querySelector('#list-filter-client');
    if (clientSel) clientSel.addEventListener('change', () => {
      if (showCompletedOnly) state.completedFilterClient = clientSel.value;
      else state.listFilterClient = clientSel.value;
      renderList(main, kind);
    });

    const brokerSel = main.querySelector('#list-filter-broker');
    if (brokerSel) brokerSel.addEventListener('change', () => {
      if (showCompletedOnly) state.completedFilterBroker = brokerSel.value;
      else state.listFilterBroker = brokerSel.value;
      renderList(main, kind);
    });

    const delBtnList = main.querySelector('#list-delete-all-btn');
    if (delBtnList) delBtnList.addEventListener('click', async () => {
      if (!confirm(`Are you sure you want to delete ${rows.length} submission(s)? This cannot be undone.`)) return;
      try {
        const ids = rows.map(r => r.id);
        const res = await fetch('/api/submissions/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        const text = await res.json();
        if (text.error) throw new Error(text.error);
        state.index = await loadIndex();
        renderList(main, kind);
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });

    main.querySelectorAll('[data-open]').forEach(tr => tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      openSubmission(tr.dataset.open);
    }));
    main.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', (e) => removeSubmission(btn.dataset.del, e)));

    if (typeFilter !== 'all') {
      main.querySelector('#list-export-btn').addEventListener('click', () => {
        window.open('/api/export-excel/' + typeFilter, '_blank');
      });

      const importBtn = main.querySelector('#list-import-btn');
      const importInput = main.querySelector('#list-import-input');
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', async () => {
        if (!importInput.files.length) return;
        const fd = new FormData();
        fd.append('file', importInput.files[0]);
        const originalText = importBtn.textContent;
        importBtn.textContent = 'Uploading…'; importBtn.disabled = true;
        try {
          const res = await fetch('/api/import-excel/' + typeFilter, { method: 'POST', body: fd });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Upload failed');
          state.index = await loadIndex();
          renderList(main, kind);
          alert(`Successfully imported ${result.created} of ${result.totalRows} row(s) as Completed records.`);
        } catch (e) {
          alert('Could not import file: ' + e.message);
          importBtn.textContent = originalText; importBtn.disabled = false;
        } finally {
          importInput.value = '';
        }
      });
    }
  }

  function typeBadgeClass(type) { return type === 'termination' ? 'type-termination' : type === 'implementation' ? 'type-implementation' : 'type-crf'; }
  // typeLabelOf defined above (duplicate removed)

  function cardHtml(entry) {
    return `<div class="subcard" data-open="${entry.id}">
      <div class="subcard-body">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="subcard-type ${typeBadgeClass(entry.type)}">${typeLabelOf(entry.type)}</span>
          <span class="stagepill-table stage-${entry.status || 'requested'}">${stageLabelOf(entry.status)}</span>
        </div>
        <div class="subcard-client">${esc(entry.client || 'Untitled')}</div>
        <div class="subcard-meta">${entry.broker ? 'Broker: ' + esc(entry.broker) : 'No broker set'} &middot; Updated ${fmtDate(entry.updatedAt)}</div>
      </div>
      <button class="task-del" title="Delete submission" data-del="${entry.id}">&#128465;</button>
    </div>`;
  }

  // ---------------- Shared field helpers ----------------


  // Missing helper functions for module forms
  function headerStatusSelect(currentStatus) {
    const stages = [
      { key: 'requested', label: 'Requested' },
      { key: 'approved', label: 'Approved' },
      { key: 'testing', label: 'In Review / Testing' },
      { key: 'completed', label: 'Completed' }
    ];
    return `<select data-field="status">
      ${stages.map(s => `<option value="${s.key}" ${s.key === (currentStatus || 'requested') ? 'selected' : ''}>${s.label}</option>`).join('')}
    </select>`;
  }

  function wireHeaderFields(main, sub) {
    if (!main || !sub) return;
    main.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('change', () => {
        const key = el.dataset.field;
        if (key.startsWith('header.')) {
          const hk = key.split('.')[1];
          if (!sub.header) sub.header = {};
          sub.header[hk] = el.value;
        } else {
          sub[key] = el.value;
        }
        setSaveState('unsaved');
      });
    });
  }

  function fieldHtml(label, key, value, type, hint) {
    type = type || 'text';
    if (type === 'textarea') return `<div class="field"><label>${label}</label><textarea data-field="${key}">${esc(value)}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    return `<div class="field"><label>${label}</label><input type="${type}" data-field="${key}" value="${esc(value)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }
  function pfield(label, path, value, type, hint) {
    type = type || 'text';
    if (type === 'textarea') return `<div class="field"><label>${label}</label><textarea data-crf-path="${path}">${esc(value)}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    return `<div class="field"><label>${label}</label><input type="${type}" data-crf-path="${path}" value="${esc(value)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }
  function pselect(label, path, value, options) {
    return `<div class="field"><label>${label}</label><select data-crf-path="${path}">
      <option value="">—</option>
      ${options.map(o => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select></div>`;
  }

  // ---------------- Render: Termination form ----------------

  function renderTermination(main) {
    const sub = state.current;
    const prog = sub.progress;
    const bySection = {};
    sub.tasks.forEach(t => { (bySection[t.section_key] = bySection[t.section_key] || []).push(t); });

    main.innerHTML = `
      <div class="back-link" id="back">&larr; Back</div>
      <div class="form-header">
        <div class="form-header-top">
          <div class="form-title">Client Termination Checklist</div>
          <div style="display:flex;gap:8px;"><button class="btn btn-primary btn-sm" id="save-btn">Save</button><button class="btn btn-ghost btn-sm" id="download-btn">Download .doc</button><button class="btn btn-danger-ghost btn-sm" id="delete-btn">Delete</button></div>
        </div>
        <div class="field-grid">
          ${fieldHtml('Client', 'client', sub.client)}
          ${fieldHtml('Broker Partner', 'broker', sub.broker)}
          ${fieldHtml('Requested Termination Date', 'header.requestedDate', sub.header.requestedDate, 'date')}
          ${fieldHtml('CRM', 'header.crm', sub.header.crm)}
          ${fieldHtml('EE Headcount', 'header.eeHeadcount', sub.header.eeHeadcount)}
          <div class="field"><label>Status</label>${headerStatusSelect(sub.status || 'requested')}</div>
          ${fieldHtml('Termination Reason', 'header.reason', sub.header.reason, 'textarea')}
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${prog.pct}%"></div></div>
        <div class="progress-label">${prog.done} of ${prog.total} tasks complete (${prog.pct}%)</div>
      </div>
      ${schema.TERMINATION_SECTIONS.map(sec => terminationSectionHtml(sec, bySection[sec.key] || [])).join('')}
      <datalist id="team-list">${schema.TEAM_NAMES.map(n => `<option value="${n}">`).join('')}</datalist>
    `;
    wireHeaderFields(main, sub);
    main.querySelector('#back').addEventListener('click', () => goView('submissions'));
    main.querySelector('#download-btn').addEventListener('click', () => window.open(`/api/submissions/${sub.id}/export`, '_blank'));
    const delBtn = main.querySelector('#delete-btn');
    if (delBtn) delBtn.addEventListener('click', (e) => removeSubmission(sub.id, e));
    wireSaveButton(main, sub);
    schema.TERMINATION_SECTIONS.forEach(sec => wireTerminationSection(main, sec));
  }

  function terminationSectionHtml(sec, tasks) {
    const doneCount = tasks.filter(t => t.status === 'completed').length;
    const active = tasks.filter(t => t.status !== 'completed');
    const completed = tasks.filter(t => t.status === 'completed');
    return `<div class="section-card" data-sec="${sec.key}" style="--sec-color:var(--c-${sec.key});--sec-tint:color-mix(in srgb, var(--c-${sec.key}) 10%, white);">
      <div class="section-head" data-toggle="${sec.key}">
        <div class="section-head-left"><div class="section-title">${sec.title}</div><div class="section-count">${doneCount}/${tasks.length}</div></div>
        <svg class="chevron open" data-chev="${sec.key}" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="section-body" data-body="${sec.key}">
        <div data-active-list="${sec.key}">${active.map(t => terminationTaskRow(sec, t)).join('')}</div>
        ${completed.length ? `<div class="completed-toggle" data-toggle-completed="${sec.key}">&#9662; ${completed.length} completed task${completed.length === 1 ? '' : 's'}</div>
        <div data-completed-list="${sec.key}" style="display:none;">${completed.map(t => terminationTaskRow(sec, t)).join('')}</div>` : ''}
        <div class="add-task-row">
          <input type="text" placeholder="Add a task to ${esc(sec.title)}…" data-addinput="${sec.key}">
          <button class="btn btn-ghost btn-sm" data-addbtn="${sec.key}">+ Add</button>
        </div>
      </div>
    </div>`;
  }

  function terminationTaskRow(sec, t) {
    const def = sec.items.find(i => i.id === t.item_key);
    const ex = t.extra_json || {};
    let extraField = '';
    if (def) {
      if (def.extra === 'date') extraField = `<input type="date" class="task-extra" data-extra="${t.id}:extraVal" value="${esc(ex.extraVal)}">`;
      else if (def.extra === 'text') extraField = `<input type="text" class="task-extra" placeholder="${def.extraLabel || 'Detail'}" data-extra="${t.id}:extraVal" value="${esc(ex.extraVal)}">`;
      else if (def.extra === 'yesno_amount') {
        extraField = `<select class="task-extra" data-extra="${t.id}:extraVal" style="width:70px;">
          <option value="" ${!ex.extraVal ? 'selected' : ''}>Fees?</option>
          <option value="yes" ${ex.extraVal === 'yes' ? 'selected' : ''}>Yes</option>
          <option value="no" ${ex.extraVal === 'no' ? 'selected' : ''}>No</option>
        </select>` + (ex.extraVal === 'yes' ? `<input type="text" class="task-extra" placeholder="$ amount" data-extra="${t.id}:extraVal2" value="${esc(ex.extraVal2)}">` : '');
      }
    }
    return `<div class="task-row ${t.status === 'completed' ? 'is-completed' : ''}" data-task="${t.id}">
      ${def && def.conditional ? `<div class="conditional-note">${def.conditional}</div>` : ''}
      <input type="checkbox" class="task-check" data-check="${t.id}" ${t.status === 'completed' ? 'checked' : ''}>
      <input type="text" class="task-label" data-label="${t.id}" value="${esc(t.label)}">
      ${extraField}
      <input type="text" class="task-notes" placeholder="Notes" data-notes="${t.id}" value="${esc(t.notes)}">
      ${t.status === 'completed' ? `<span class="task-completed-meta">&#10003; ${fmtDate(t.completed_on)}</span>` : ''}
      <button class="task-del" title="Delete task" data-del-task="${t.id}">&#128465;</button>
    </div>`;
  }

  function wireTerminationSection(main, sec) {
    const sub = state.current;
    const card = main.querySelector(`[data-sec="${sec.key}"]`);
    if (!card) return;

    function rerenderSection() {
      const tasks = sub.tasks.filter(t => t.section_key === sec.key);
      const fresh = document.createElement('div');
      fresh.innerHTML = terminationSectionHtml(sec, tasks);
      card.replaceWith(fresh.firstElementChild);
      wireTerminationSection(main, sec);
    }

    card.querySelector('[data-toggle]').addEventListener('click', () => {
      const body = card.querySelector('.section-body'); const chev = card.querySelector('.chevron');
      body.classList.toggle('collapsed'); chev.classList.toggle('open');
    });
    const compToggle = card.querySelector('[data-toggle-completed]');
    if (compToggle) compToggle.addEventListener('click', () => {
      const list = card.querySelector(`[data-completed-list="${sec.key}"]`);
      list.style.display = list.style.display === 'none' ? '' : 'none';
    });

    card.querySelectorAll('[data-check]').forEach(cb => {
      cb.addEventListener('change', () => {
        const task = sub.tasks.find(t => t.id === cb.dataset.check);
        if (task) {
          task.status = cb.checked ? 'completed' : 'requested';
          task.completed_on = cb.checked ? new Date().toISOString().slice(0, 10) : '';
          setSaveState('unsaved');
          rerenderSection();
          refreshHeaderProgress(main);
        }
      });
    });
    card.querySelectorAll('[data-label]').forEach(inp => {
      inp.addEventListener('input', () => {
        const task = sub.tasks.find(t => t.id === inp.dataset.label);
        if (task) {
          task.label = inp.value;
          setSaveState('unsaved');
        }
      });
    });
    card.querySelectorAll('[data-notes]').forEach(inp => {
      inp.addEventListener('input', () => {
        const task = sub.tasks.find(t => t.id === inp.dataset.notes);
        if (task) {
          task.notes = inp.value;
          setSaveState('unsaved');
        }
      });
    });
    card.querySelectorAll('[data-extra]').forEach(inp => {
      const evt = inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(evt, () => {
        const [taskId, field] = inp.dataset.extra.split(':');
        const task = sub.tasks.find(t => t.id === taskId);
        if (task) {
          task.extra_json = task.extra_json || {};
          task.extra_json[field] = inp.value;
          setSaveState('unsaved');
          if (field === 'extraVal') rerenderSection();
        }
      });
    });
    card.querySelectorAll('[data-del-task]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this task?')) return;
        sub.tasks = sub.tasks.filter(t => t.id !== btn.dataset.delTask);
        setSaveState('unsaved');
        rerenderSection();
        refreshHeaderProgress(main);
      });
    });
    const addBtn = card.querySelector('[data-addbtn]');
    const addInput = card.querySelector('[data-addinput]');
    if (addBtn) addBtn.addEventListener('click', () => {
      const val = addInput.value.trim(); if (!val) return;
      const newT = {
        id: 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        submission_id: sub.id,
        section_key: sec.key,
        item_key: 'custom_' + Date.now().toString(36),
        label: val,
        status: 'requested',
        assignee: '',
        completed_on: '',
        notes: '',
        extra_json: {}
      };
      sub.tasks.push(newT);
      setSaveState('unsaved');
      rerenderSection();
      refreshHeaderProgress(main);
    });
    if (addInput) addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  }

  function refreshHeaderProgress(main) {
    const sub = state.current;
    const prog = sub.progress;
    const fill = main.querySelector('.progress-fill'); const label = main.querySelector('.progress-label');
    if (fill) fill.style.width = prog.pct + '%';
    if (label) label.textContent = `${prog.done} of ${prog.total} ${sub.type === 'termination' ? 'tasks' : 'sections'} complete (${prog.pct}%)`;
    // also refresh section-level counts on the page
    if (sub.type === 'termination') {
      schema.TERMINATION_SECTIONS.forEach(sec => {
        const tasks = sub.tasks.filter(t => t.section_key === sec.key);
        const done = tasks.filter(t => t.status === 'completed').length;
        const el = main.querySelector(`[data-sec="${sec.key}"] .section-count`);
        if (el) el.textContent = `${done}/${tasks.length}`;
      });
    } else {
      const catEl = main.querySelector('[data-sec="categories"] .section-count');
      if (catEl) {
        const cats = sub.tasks.filter(t => t.section_key === 'categories');
        catEl.textContent = `${cats.filter(c => c.status === 'completed').length}/${cats.length}`;
      }
    }
  }

  function wireHeaderFields(main, sub) {
    main.querySelectorAll('[data-field]').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const key = el.dataset.field;
        if (key.startsWith('header.')) {
          const hk = key.split('.')[1];
          sub.header[hk] = el.value;
        } else {
          sub[key] = el.value;
        }

        if (key === 'status') {
          const s = el.value;
          const today = new Date().toISOString().slice(0, 10);
          if (!sub.header) sub.header = {};
          if (!sub.body) sub.body = {};

          if (s === 'requested') {
            if (sub.type === 'crf') {
              if (!sub.body.request) sub.body.request = {};
              if (!sub.body.request.dateOfRequest) sub.body.request.dateOfRequest = today;
            }
          } else if (s === 'approved') {
            if (sub.type === 'crf') {
              if (!sub.body.approval) sub.body.approval = {};
              if (!sub.body.approval.approvedDate) sub.body.approval.approvedDate = today;
            }
          } else if (s === 'completed') {
            if (sub.type === 'crf' && !sub.header.completedOn) sub.header.completedOn = today;
            if (sub.type === 'implementation' && !sub.header.implementationCompletion) sub.header.implementationCompletion = today;
          }
          if (sub.type === 'crf') renderCRF(main);
          else if (sub.type === 'implementation') renderImplementation(main);
          else if (sub.type === 'open_enrollment') renderOpenEnrollment(main);
          else if (sub.type === 'termination') renderTermination(main);
          else renderCRF(main);
        }

        setSaveState('unsaved');
      });
    });
  }
  function headerStatusSelect(value) {
    return `<select class="form-control" data-field="status" style="border:1px solid var(--border);border-radius:7px;padding:8px 10px;font-size:13.5px;width:100%;">
      ${schema.STAGES.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`;
  }

  // ---------------- Render: CRF form ----------------


  // ---------------- Render: Open Enrollment form ----------------

  function renderOpenEnrollment(main) {
    const sub = state.current;
    if (!sub.header) sub.header = {};
    if (!sub.body) sub.body = {};
    const h = sub.header;
    const b = sub.body;

    main.innerHTML = `
      <div class="back-link" id="back">&larr; Back</div>
      <div class="form-header">
        <div class="form-header-top">
          <div class="form-title">Open Enrollment Form</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" id="save-btn">Save</button>
            <button class="btn btn-danger-ghost btn-sm" id="delete-btn">Delete</button>
          </div>
        </div>
        <div class="field-grid">
          ${fieldHtml('Client Name', 'client', sub.client)}
          ${fieldHtml('Broker Partner', 'broker', sub.broker)}
          ${fieldHtml('Config Analyst', 'header.configAnalyst', h.configAnalyst || b.configAnalyst)}
          <div class="field"><label>Status</label>${headerStatusSelect(sub.status || 'requested')}</div>
        </div>
      </div>

      <div class="section-card" style="--sec-color:#3b82f6;">
        <div class="section-head"><div class="section-title">📅 OE Key Dates &amp; Timeline</div></div>
        <div class="section-body">
          <div class="field-grid">
            ${fieldHtml('OE Renewal Doc Received Date', 'header.oeDocReceivedDate', h.oeDocReceivedDate || b.oeDocReceivedDate, 'date')}
            ${fieldHtml('OE Start Date', 'header.oeStartDate', h.oeStartDate || b.oeStartDate, 'date')}
            ${fieldHtml('OE End Date', 'header.oeEndDate', h.oeEndDate || b.oeEndDate, 'date')}
            ${fieldHtml('OE Effective Date', 'header.oeEffectiveDate', h.oeEffectiveDate || b.oeEffectiveDate, 'date')}
          </div>
        </div>
      </div>

      <div class="section-card" style="--sec-color:#8b5cf6;">
        <div class="section-head"><div class="section-title">⚙️ Type of OE &amp; Plan Configuration</div></div>
        <div class="section-body">
          <div class="field-grid">
            <div class="field"><label>Type of OE</label>
              <select data-field="header.typeOfOe">
                <option value="">— Select —</option>
                <option value="Active" ${(h.typeOfOe || b.typeOfOe) === 'Active' ? 'selected' : ''}>Active</option>
                <option value="Passive" ${(h.typeOfOe || b.typeOfOe) === 'Passive' ? 'selected' : ''}>Passive</option>
                <option value="Active+Passive" ${(h.typeOfOe || b.typeOfOe) === 'Active+Passive' ? 'selected' : ''}>Active+Passive</option>
              </select>
            </div>
            <div class="field"><label>List or WorkFlow OE</label>
              <select data-field="header.listOrWorkflow">
                <option value="">— Select —</option>
                <option value="List" ${(h.listOrWorkflow || b.listOrWorkflow) === 'List' ? 'selected' : ''}>List</option>
                <option value="WorkFlow" ${(h.listOrWorkflow || b.listOrWorkflow) === 'WorkFlow' ? 'selected' : ''}>WorkFlow</option>
              </select>
            </div>
            ${fieldHtml('Plans with Active OE', 'header.activePlans', h.activePlans || b.activePlans)}
            ${fieldHtml('Plans with Passive OE', 'header.passivePlans', h.passivePlans || b.passivePlans)}
          </div>
        </div>
      </div>

      <div class="section-card" style="--sec-color:#10b981;">
        <div class="section-head"><div class="section-title">📊 Setup &amp; Review Status</div></div>
        <div class="section-body">
          <div class="field-grid">
            <div class="field"><label>OE Setup Status</label>
              <select data-field="header.setupStatus">
                <option value="">— Select —</option>
                <option value="Completed" ${(h.setupStatus || b.setupStatus) === 'Completed' ? 'selected' : ''}>Completed</option>
                <option value="Inprogress" ${(h.setupStatus || b.setupStatus) === 'Inprogress' ? 'selected' : ''}>Inprogress</option>
                <option value="Pending" ${(h.setupStatus || b.setupStatus) === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="NA" ${(h.setupStatus || b.setupStatus) === 'NA' ? 'selected' : ''}>NA</option>
              </select>
            </div>
            <div class="field"><label>OE Review / Testing Status</label>
              <select data-field="header.testingStatus">
                <option value="">— Select —</option>
                <option value="Completed" ${(h.testingStatus || b.testingStatus) === 'Completed' ? 'selected' : ''}>Completed</option>
                <option value="Both Completed" ${(h.testingStatus || b.testingStatus) === 'Both Completed' ? 'selected' : ''}>Both Completed</option>
                <option value="Testing - Inprogress" ${(h.testingStatus || b.testingStatus) === 'Testing - Inprogress' ? 'selected' : ''}>Testing - Inprogress</option>
                <option value="Pending" ${(h.testingStatus || b.testingStatus) === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="NA" ${(h.testingStatus || b.testingStatus) === 'NA' ? 'selected' : ''}>NA</option>
              </select>
            </div>
            ${fieldHtml('OE Finalization Start & End Date', 'header.finalizationStartEndDate', h.finalizationStartEndDate || b.finalizationStartEndDate)}
            ${fieldHtml('HGS Comments / Notes', 'header.comments', h.comments || b.comments, 'textarea')}
          </div>
          <div class="section-card" style="--sec-color:#f59e0b;">
          <div class="section-head">
            <div class="section-title">📋 OE Finalization & Communication</div>
          </div>

          <div class="section-body">
            <div class="field-grid">

              ${fieldHtml(
      'CRM',
      'header.crm',
      h.crm || b.crm
    )}

              ${fieldHtml(
      'OE End Date (HR)',
      'header.oeEndDateHR',
      h.oeEndDateHR || b.oeEndDateHR,
      'date'
    )}

              <div class="field">
                <label>Finalization Rules Status</label>
                <select data-field="header.finalizationRulesStatus">
                  <option value="">— Select —</option>
                  <option value="Completed"
                    ${(h.finalizationRulesStatus || b.finalizationRulesStatus) === 'Completed' ? 'selected' : ''}>
                    Completed
                  </option>
                  <option value="Inprogress"
                    ${(h.finalizationRulesStatus || b.finalizationRulesStatus) === 'Inprogress' ? 'selected' : ''}>
                    In Progress
                  </option>
                  <option value="Pending"
                    ${(h.finalizationRulesStatus || b.finalizationRulesStatus) === 'Pending' ? 'selected' : ''}>
                    Pending
                  </option>
                  <option value="NA"
                    ${(h.finalizationRulesStatus || b.finalizationRulesStatus) === 'NA' ? 'selected' : ''}>
                    N/A
                  </option>
                </select>
              </div>

              ${fieldHtml(
      'Announcement Email to be Sent By',
      'header.announcementEmailSentBy',
      h.announcementEmailSentBy || b.announcementEmailSentBy,
      'date'
    )}

              ${fieldHtml(
      'Reminder Emails Frequency',
      'header.reminderEmailsFrequency',
      h.reminderEmailsFrequency || b.reminderEmailsFrequency
    )}

              <div class="field">
                <label>OE Closure</label>
                <select data-field="header.oeClosure">
                  <option value="">— Select —</option>
                  <option value="Open"
                    ${(h.oeClosure || b.oeClosure) === 'Open' ? 'selected' : ''}>
                    Open
                  </option>
                  <option value="Closed"
                    ${(h.oeClosure || b.oeClosure) === 'Closed' ? 'selected' : ''}>
                    Closed
                  </option>
                  <option value="NA"
                    ${(h.oeClosure || b.oeClosure) === 'NA' ? 'selected' : ''}>
                    N/A
                  </option>
                </select>
              </div>

              ${fieldHtml(
      'OE Finalization Date',
      'header.oeFinalizationDate',
      h.oeFinalizationDate || b.oeFinalizationDate,
      'date'
    )}

            </div>
          </div>
        </div>
        </div>
      </div>
    `;

    wireHeaderFields(main, sub);
    main.querySelector('#back').addEventListener('click', () => goView('home'));
    const oeDelBtn = main.querySelector('#delete-btn');
    if (oeDelBtn) oeDelBtn.addEventListener('click', (e) => removeSubmission(sub.id, e));
    wireSaveButton(main, sub);
  }


  function renderCRF(main) {
    const sub = state.current;
    const prog = sub.progress;
    const catTasks = sub.tasks.filter(t => t.section_key === 'categories');
    const today = new Date().toISOString().slice(0, 10);
    if (!sub.header) sub.header = {};
    if (!sub.header.submittedOn) sub.header.submittedOn = today;
    const b = sub.body;
    b.request = b.request || {}; b.solution = b.solution || {}; b.note = b.note || {};
    if (!b.request.dateOfRequest) b.request.dateOfRequest = today;
    b.approval = b.approval || {}; b.finalSolution = b.finalSolution || {}; b.sow = b.sow || {}; b.action = b.action || {};

    main.innerHTML = `
      <div class="back-link" id="back">&larr; Back</div>
      <div class="notice">Save each completed request as <i>&lt;Client Name&gt; CRF &lt;change info&gt; &lt;date&gt;</i> and share only via the SharePoint link.</div>
      <div class="form-header">
        <div class="form-header-top">
          <div class="form-title">Change Request Form (CRF)</div>
          <div style="display:flex;gap:8px;"><button class="btn btn-primary btn-sm" id="save-btn">Save</button><button class="btn btn-ghost btn-sm" id="download-btn">Download .doc</button><button class="btn btn-danger-ghost btn-sm" id="delete-btn">Delete</button></div>
        </div>
        <div class="field-grid">
          ${fieldHtml('Reference Conversation No.', 'header.refConversation', sub.header.refConversation)}
          ${fieldHtml('Submitted By', 'header.submittedBy', sub.header.submittedBy)}
          ${fieldHtml('Submitted On', 'header.submittedOn', sub.header.submittedOn, 'date')}
          ${fieldHtml('Completed On', 'header.completedOn', sub.header.completedOn, 'date')}
          ${fieldHtml('Client', 'client', sub.client)}
          ${fieldHtml('Broker Partner', 'broker', sub.broker)}
          <div class="field"><label>Status</label>${headerStatusSelect(sub.status || 'requested')}</div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${prog.pct}%"></div></div>
        <div class="progress-label">${prog.done} of ${prog.total} sections complete (${prog.pct}%)</div>
      </div>

      ${crfSectionShell('request', 'Request', crfRequestBody(b))}
      ${crfSectionShell('solution', 'Suggested Change / Solution', crfSolutionBody(b))}
      ${crfSectionShell('note', 'Note', crfNoteBody(b))}
      ${crfSectionShell('approval', 'Approval of Solution & Fees', crfApprovalBody(b))}
      ${crfSectionShell('finalSolution', 'Final Solution', crfFinalBody(b))}
      ${crfSectionShell('sow', 'Action Required & Statement of Work', crfSowBody(b))}
      ${crfSectionShell('tracking', 'Tracking & Metrics', crfTrackingBody(b))}
      
      <datalist id="team-list">${schema.TEAM_NAMES.map(n => `<option value="${n}">`).join('')}</datalist>
    `;
    wireHeaderFields(main, sub);
    main.querySelector('#back').addEventListener('click', () => goView('submissions'));
    main.querySelector('#download-btn').addEventListener('click', () => window.open(`/api/submissions/${sub.id}/export`, '_blank'));
    const crfDelBtn = main.querySelector('#delete-btn');
    if (crfDelBtn) crfDelBtn.addEventListener('click', (e) => removeSubmission(sub.id, e));
    wireSaveButton(main, sub);
    wireCrfCommon(main);
  }

  // ---------------- Render: Client Implementation Checklist ----------------

  function renderImplementation(main) {
    const sub = state.current;
    const h = sub.header;
    main.innerHTML = `
      <div class="back-link" id="back">&larr; Back</div>
      <div class="form-header">
        <div class="form-header-top">
          <div class="form-title">Client Implementation Checklist</div>
          <div style="display:flex;gap:8px;"><button class="btn btn-primary btn-sm" id="save-btn">Save</button><button class="btn btn-ghost btn-sm" id="download-btn">Download .doc</button><button class="btn btn-danger-ghost btn-sm" id="delete-btn">Delete</button></div>
        </div>
        <div class="field-grid">
          ${fieldHtml('Client Name', 'client', sub.client)}
          ${fieldHtml('Broker', 'broker', sub.broker)}
          ${(schema.IMPLEMENTATION_FIELDS || []).map(f => fieldHtml(f.label, 'header.' + f.key, h[f.key], f.type)).join('')}
          <div class="field"><label>Status</label>${headerStatusSelect(sub.status || 'requested')}</div>
        </div>
      </div>
      <div class="hint" style="padding:4px 4px 20px;">This checklist tracks a single client implementation record — fill in the dates and headcount as they become available, then update the status as it progresses.</div>
    `;
    wireHeaderFields(main, sub);
    main.querySelector('#back').addEventListener('click', () => goView('submissions'));
    main.querySelector('#download-btn').addEventListener('click', () => window.open(`/api/submissions/${sub.id}/export`, '_blank'));
    const implDelBtn = main.querySelector('#delete-btn');
    if (implDelBtn) implDelBtn.addEventListener('click', (e) => removeSubmission(sub.id, e));
    wireSaveButton(main, sub);
  }

  function crfSectionShell(key, title, bodyHtml) {
    return `<div class="section-card" data-sec="${key}" style="--sec-color:var(--c-${key});--sec-tint:color-mix(in srgb, var(--c-${key}) 10%, white);">
      <div class="section-head" data-toggle="${key}">
        <div class="section-head-left"><div class="section-title">${title}</div></div>
        <svg class="chevron open" data-chev="${key}" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="section-body" data-body="${key}">
        ${bodyHtml}
      </div>
    </div>`;
  }

  function radio(path, val, current, label) {
    return `<label class="radio-item"><input type="radio" name="${path}" data-crf-path="${path}" value="${val}" ${current === val ? 'checked' : ''}> ${label}</label>`;
  }
  function cb(path, checked, label) {
    return `<label class="cb-item"><input type="checkbox" data-crf-check="${path}" ${checked ? 'checked' : ''}> ${label}</label>`;
  }

  function crfRequestBody(b) {
    const r = b.request;
    return `<div class="field-grid">
        ${pfield('Requested by', 'request.requestedBy', r.requestedBy)}
        ${pfield('Date of request', 'request.dateOfRequest', r.dateOfRequest, 'date')}
      </div>
      <div style="margin-top:10px" class="radio-group">
        <span class="hint" style="align-self:center">Was the initial request modified?</span>
        ${radio('request.modified', 'yes', r.modified, 'Yes')}${radio('request.modified', 'no', r.modified, 'No')}
      </div>
      <div class="field" style="margin-top:10px"><label>What is the request and why?</label><textarea data-crf-path="request.requestText">${esc(r.requestText)}</textarea></div>
      <div class="field-grid" style="margin-top:10px">${pfield('Desired completion date', 'request.desiredCompletion', r.desiredCompletion, 'date')}</div>`;
  }
  function crfSolutionBody(b) {
    const s = b.solution;
    return `<div class="field-grid">
        ${pfield('Solution Architect', 'solution.architect', s.architect)}
        ${pfield('Reviewed on', 'solution.reviewedOn', s.reviewedOn, 'date')}
      </div>
      <div class="field" style="margin-top:8px"><label>Proposed solution</label><textarea data-crf-path="solution.proposedSolution">${esc(s.proposedSolution)}</textarea></div>
      <div class="field-grid" style="margin-top:10px">
        <div class="field"><label>Fee</label><div style="display:flex;gap:8px;">
          <input type="text" placeholder="$ amount" data-crf-path="solution.fee" value="${esc(s.fee)}" ${s.feeNone ? 'disabled' : ''}>
          <label class="cb-item"><input type="checkbox" data-crf-check="solution.feeNone" ${s.feeNone ? 'checked' : ''}> None</label>
        </div></div>
        ${pfield('Proposed completion date', 'solution.proposedCompletion', s.proposedCompletion, 'date')}
      </div>`;
  }
  function crfNoteBody(b) {
    const n = b.note;
    return `<div class="radio-group" style="flex-direction:column;align-items:flex-start;">
      ${radio('note.kind', 'change', n.kind, 'Change — from what was requested earlier by Customer')}
      ${radio('note.kind', 'correction', n.kind, 'Correction — of how request was implemented')}
    </div>`;
  }
  function crfApprovalBody(b) {
    const a = b.approval;
    return `<div class="field-grid">
        ${pfield('Approved by', 'approval.approvedBy', a.approvedBy)}
        ${pfield('Date', 'approval.approvedDate', a.approvedDate, 'date')}
        ${pfield('Ticket #', 'approval.ticketNo', a.ticketNo)}
      </div>
      <div class="radio-group" style="margin-top:10px">
        <span class="hint" style="align-self:center">Fees charged?</span>
        ${radio('approval.feesCharged', 'yes', a.feesCharged, 'Yes')}${radio('approval.feesCharged', 'no', a.feesCharged, 'No')}
      </div>
      ${a.feesCharged === 'yes' ? `<div class="field-grid" style="margin-top:10px">${pfield('HelloSign ticket #', 'approval.helloSignTicket', a.helloSignTicket)}</div>` : ''}`;
  }
  function crfFinalBody(b) {
    const f = b.finalSolution;
    return `<div class="checkbox-group"><label class="cb-item"><input type="checkbox" data-crf-check="finalSolution.approved" ${f.approved ? 'checked' : ''}> Approved</label></div>
      <div class="field-grid" style="margin-top:8px">${pfield('Date promised', 'finalSolution.datePromised', f.datePromised, 'date')}</div>`;
  }
  function crfTrackingBody(b) {
    const tr = b.tracking || {};
    const gridFields = (schema.TRACKING_FIELDS || []).filter(f => f.type !== 'textarea');
    const textFields = (schema.TRACKING_FIELDS || []).filter(f => f.type === 'textarea');
    return `<div class="field-grid">
      ${gridFields.map(f => f.type === 'select' ? pselect(f.label, 'tracking.' + f.key, tr[f.key] || '', f.options) : pfield(f.label, 'tracking.' + f.key, tr[f.key] || '')).join('')}
    </div>
    ${textFields.map(f => `<div style="margin-top:10px">${pfield(f.label, 'tracking.' + f.key, tr[f.key] || '', 'textarea')}</div>`).join('')}
    <div class="hint" style="margin-top:8px;">These fields match your CRF Config Master Tracker spreadsheet columns, so the Excel export lines up directly.</div>`;
  }

  function crfSowBody(b) {
    const a = b.action, s = b.sow;
    return `<div class="checkbox-group">
        ${cb('action.configChange', a.configChange, 'Configuration Change')}${cb('action.maintenanceFix', a.maintenanceFix, 'Maintenance Fix')}
        ${cb('action.dataFix', a.dataFix, 'Data Fix')}${cb('action.sprintRelease', a.sprintRelease, 'Sprint Release')}
        ${cb('action.edi', a.edi, 'EDI')}${cb('action.processChange', a.processChange, 'Process Change')}
      </div>
      <div class="field" style="margin-top:10px"><label>Describe Statement of Work</label><textarea data-crf-path="sow.text" style="min-height:100px">${esc(s.text)}</textarea></div>
      <div class="field" style="margin-top:8px"><label>Screenshots / images (reference or link)</label>
        <input type="text" placeholder="Paste link or filename" data-crf-path="sow.screenshotNote" value="${esc(s.screenshotNote)}">
      </div>`;
  }

  function crfCategoriesShell(catTasks) {
    const groups = {};
    catTasks.forEach(c => { const g = c.label.includes(' — ') ? c.label.split(' — ')[0] : 'Other'; (groups[g] = groups[g] || []).push(c); });
    const rows = Object.keys(groups).map(g => `
      <div class="cat-group-title">${g}</div>
      ${groups[g].map(c => `<div class="cat-row" data-cat-row="${c.id}">
        <label class="cb-item"><input type="checkbox" data-cat-check="${c.id}" ${c.status === 'completed' ? 'checked' : ''}> <input type="text" class="task-label" style="width:auto;" data-cat-label="${c.id}" value="${esc(c.label)}"></label>
        ${Object.keys(c.extra_json || {}).length ? `<div class="cat-sub-fields">${Object.keys(c.extra_json).map(s => `<input type="text" placeholder="${s[0].toUpperCase() + s.slice(1)}" data-cat-sub="${c.id}:${s}" value="${esc(c.extra_json[s])}">`).join('')}</div>` : ''}
        <button class="task-del" data-del-cat="${c.id}">&#128465;</button>
      </div>`).join('')}
    `).join('');
    return `<div class="section-card" data-sec="categories" style="--sec-color:var(--c-categories);--sec-tint:color-mix(in srgb, var(--c-categories) 10%, white);">
      <div class="section-head" data-toggle="categories">
        <div class="section-head-left"><div class="section-title">Change Category</div><div class="section-count">${catTasks.filter(c => c.status === 'completed').length}/${catTasks.length}</div></div>
        <svg class="chevron open" data-chev="categories" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="section-body" data-body="categories">
        ${rows}
        <div class="add-task-row">
          <input type="text" placeholder="Add a custom category…" id="cat-add-input">
          <button class="btn btn-ghost btn-sm" id="cat-add-btn">+ Add</button>
        </div>
      </div>
    </div>`;
  }

  function wireCrfCommon(main) {
    const sub = state.current;

    main.querySelectorAll('[data-toggle]').forEach(head => {
      head.addEventListener('click', () => {
        const key = head.dataset.toggle;
        const body = main.querySelector(`[data-body="${key}"]`);
        const chev = main.querySelector(`[data-chev="${key}"]`);
        body.classList.toggle('collapsed'); chev.classList.toggle('open');
      });
    });


    // Category Sync: Checking any category under "Change Category" updates the "Tracking & Metrics" Category dropdown
    main.querySelectorAll('[data-cat-check]').forEach(cb => {
      cb.addEventListener('change', () => {
        const catRow = cb.closest('[data-cat-row]');
        if (catRow && cb.checked) {
          const labelInp = catRow.querySelector('[data-cat-label]');
          const labelVal = labelInp ? labelInp.value.trim() : '';
          let targetCat = 'Plan Configuration';
          if (labelVal.includes('Rules') || labelVal.includes('Rates')) targetCat = 'Plan Configuration';
          else if (labelVal.includes('Setup') || labelVal.includes('Client')) targetCat = 'Client Setup';
          else if (labelVal.includes('Deductions') || labelVal.includes('Billing')) targetCat = 'Benefit Changes';
          else if (labelVal.includes('EDI') || labelVal.includes('Feature') || labelVal.includes('Notifications') || labelVal.includes('Process')) targetCat = 'System Enhancement';
          else targetCat = 'Other';

          sub.body.tracking = sub.body.tracking || {};
          sub.body.tracking.category = targetCat;
          const trackingSel = main.querySelector('[data-crf-path="tracking.category"]');
          if (trackingSel) trackingSel.value = targetCat;
          setSaveState('unsaved');
        }
      });
    });


    main.querySelectorAll('[data-crf-path]').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : (el.type === 'radio' ? 'change' : 'input');
      el.addEventListener(evt, () => {
        const parts = el.dataset.crfPath.split('.');
        const topKey = parts[0];
        sub.body[topKey] = sub.body[topKey] || {};
        sub.body[topKey][parts[1]] = el.value;
        setSaveState('unsaved');
        if (el.name === 'approval.feesCharged') {
          renderCRF(main);
        }
      });
    });
    main.querySelectorAll('[data-crf-check]').forEach(el => {
      el.addEventListener('change', () => {
        const parts = el.dataset.crfCheck.split('.');
        const topKey = parts[0];
        sub.body[topKey] = sub.body[topKey] || {};
        sub.body[topKey][parts[1]] = el.checked;
        setSaveState('unsaved');
        if (el.dataset.crfCheck === 'solution.feeNone') renderCRF(main);
      });
    });
    main.querySelectorAll('[data-cat-check]').forEach(el => {
      el.addEventListener('change', () => {
        const task = sub.tasks.find(t => t.id === el.dataset.catCheck);
        if (task) {
          task.status = el.checked ? 'completed' : 'requested';
          setSaveState('unsaved');
          refreshHeaderProgress(main);
        }
      });
    });
    main.querySelectorAll('[data-cat-label]').forEach(el => {
      el.addEventListener('input', () => {
        const task = sub.tasks.find(t => t.id === el.dataset.catLabel);
        if (task) {
          task.label = el.value;
          setSaveState('unsaved');
        }
      });
    });
    main.querySelectorAll('[data-cat-sub]').forEach(el => {
      el.addEventListener('input', () => {
        const [cid, field] = el.dataset.catSub.split(':');
        const task = sub.tasks.find(t => t.id === cid);
        if (task) {
          task.extra_json = task.extra_json || {};
          task.extra_json[field] = el.value;
          setSaveState('unsaved');
        }
      });
    });
    main.querySelectorAll('[data-del-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this category item?')) return;
        sub.tasks = sub.tasks.filter(t => t.id !== btn.dataset.delCat);
        setSaveState('unsaved');
        renderCRF(main);
      });
    });
    const catAddBtn = main.querySelector('#cat-add-btn');
    const catAddInput = main.querySelector('#cat-add-input');
    if (catAddBtn) catAddBtn.addEventListener('click', () => {
      const val = catAddInput.value.trim(); if (!val) return;
      const newT = {
        id: 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        submission_id: sub.id,
        section_key: 'categories',
        item_key: 'custom_' + Date.now().toString(36),
        label: val,
        status: 'requested',
        assignee: '',
        completed_on: '',
        notes: '',
        extra_json: {}
      };
      sub.tasks.push(newT);
      setSaveState('unsaved');
      renderCRF(main);
    });
    if (catAddInput) catAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); catAddBtn.click(); } });
  }


  // ---------------- Notifications ----------------

  function renderNotifications(main) {
    const requestedItems = state.dismissedNotifs ? [] : state.index.filter(x => x.status === 'requested');

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
        <div>
          <div style="font-weight:700;font-size:20px;font-family:'Space Grotesk',sans-serif;">Notifications — Recent Requests</div>
          <div class="hint">${requestedItems.length} active request notification${requestedItems.length === 1 ? '' : 's'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="notif-search" placeholder="Search notifications…" class="form-control" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;width:240px;">
          ${requestedItems.length > 0 ? `<button class="btn btn-ghost btn-sm" id="tab-notif-clear">Dismiss All</button>` : ''}
        </div>
      </div>

      ${requestedItems.length === 0 ? `
        <div class="empty-state" style="padding:60px 24px;">
          <div style="font-size:40px;margin-bottom:12px;">🔔</div>
          <div style="font-weight:600;font-size:16px;margin-bottom:6px;">No new notifications</div>
          <div class="hint">When new requests or changes are submitted, they will appear here and in the bell icon.</div>
        </div>
      ` : `
        <div id="notif-feed" style="display:flex;flex-direction:column;gap:12px;">
          ${requestedItems.map(r => `
            <div class="notif-card" data-notif-open="${r.id}" style="
              background:var(--surface);border:1px solid var(--border);border-radius:12px;
              padding:16px 20px;box-shadow:var(--shadow);cursor:pointer;
              border-left:4px solid var(--accent);transition:box-shadow 0.15s,transform 0.12s;
              display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
            ">
              <div style="display:flex;gap:14px;align-items:center;flex:1;min-width:200px;">
                <span class="subcard-type ${typeBadgeClass(r.type)}" style="margin:0;">${typeLabelOf(r.type)}</span>
                <div>
                  <div style="font-weight:600;font-size:14.5px;color:var(--ink);">${esc(r.client || 'Untitled Client')}</div>
                  <div style="font-size:12px;color:var(--ink-soft);">${r.broker ? 'Broker: ' + esc(r.broker) : 'No broker specified'}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:14px;">
                <span class="stagepill-table stage-${r.status || 'requested'}">${stageLabelOf(r.status)}</span>
                <div style="font-size:11.5px;color:var(--ink-faint);text-align:right;">
                  Updated: ${fmtDate(r.updatedAt)}
                </div>
                <button class="btn btn-primary btn-sm" style="pointer-events:none;">Open</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;

    // Click card to open submission
    main.querySelectorAll('[data-notif-open]').forEach(card => {
      card.addEventListener('click', () => {
        openSubmission(card.dataset.notifOpen);
      });
    });

    const tabClearBtn = main.querySelector('#tab-notif-clear');
    if (tabClearBtn) {
      tabClearBtn.addEventListener('click', () => {
        state.dismissedNotifs = true;
        render();
      });
    }

    // Search filter
    const searchInput = main.querySelector('#notif-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        main.querySelectorAll('.notif-card').forEach(card => {
          const text = card.textContent.toLowerCase();
          card.style.display = text.includes(q) ? '' : 'none';
        });
      });
    }
  }

  // ---------------- Tracker Records Table (read-only) ----------------

  async function renderTrackerTable(main) {
    main.innerHTML = `<div style="display:flex;justify-content:center;padding:60px;"><div class="spinner"></div></div>`;
    state.index = await loadIndex();
    const records = state.index;

    const activeTab = state.trackerTab || 'all';
    const activeStatus = state.trackerStatusFilter || 'all';
    state.trackerDateFieldFilter = state.trackerDateFieldFilter || 'any';
    const selectedDateField = state.trackerDateFieldFilter;
    state.trackerYearFilter = state.trackerYearFilter || 'all';
    const selectedYear = state.trackerYearFilter;

    const getTargetDate = (r, fieldType) => {
      if (fieldType === 'received') return r.requestDate || r.oeDocReceivedDate || r.renewalDocReceivedDate || r.designGuideReceived || r.terminationDate;
      if (fieldType === 'completed') return r.completedDate || r.implementationCompletion || r.clientGoLive || r.oeEffectiveDate || r.oeFinalizationDate;
      if (fieldType === 'updated') return r.updatedAt || r.createdAt || r.created_at;
      return r.requestDate || r.oeDocReceivedDate || r.renewalDocReceivedDate || r.designGuideReceived || r.terminationDate || r.completedDate || r.implementationCompletion || r.clientGoLive || r.oeEffectiveDate || r.oeFinalizationDate || r.updatedAt || r.createdAt || r.created_at;
    };

    // Extract unique years from records
    const yearsSet = new Set();
    records.forEach(r => {
      const dStr = getTargetDate(r, selectedDateField);
      if (dStr) {
        const y = new Date(dStr).getFullYear();
        if (!isNaN(y) && y > 2000 && y < 2100) yearsSet.add(y);
      }
    });
    yearsSet.add(new Date().getFullYear());
    const years = Array.from(yearsSet).sort((a, b) => b - a);

    // Filter by module type
    let filtered = activeTab === 'all' ? records : records.filter(r => r.type === activeTab);

    // Filter by status if specified
    if (activeStatus !== 'all') {
      if (activeStatus === 'testing') {
        filtered = filtered.filter(r => r.status === 'testing' || r.status === 'in_progress' || r.status === 'review');
      } else {
        filtered = filtered.filter(r => r.status === activeStatus);
      }
    }

    // Filter by date field and year
    if (selectedYear !== 'all') {
      filtered = filtered.filter(r => {
        const dStr = getTargetDate(r, selectedDateField);
        if (!dStr) return false;
        return String(new Date(dStr).getFullYear()) === String(selectedYear);
      });
    }

    const counts = {
      all: records.length,
      crf: records.filter(r => r.type === 'crf').length,
      open_enrollment: records.filter(r => r.type === 'open_enrollment').length,
      termination: records.filter(r => r.type === 'termination').length,
      implementation: records.filter(r => r.type === 'implementation').length,
      requested: records.filter(r => r.status === 'requested').length,
      approved: records.filter(r => r.status === 'approved').length,
      testing: records.filter(r => r.status === 'testing' || r.status === 'in_progress' || r.status === 'review').length,
      completed: records.filter(r => r.status === 'completed').length,
    };

    function moduleTabBtn(key, label, count) {
      const active = activeTab === key;
      return `<button class="tracker-tab-btn" data-ttab="${key}" style="
        padding:8px 18px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;
        border:1px solid ${active ? '#2563eb' : '#e2e8f0'};background:${active ? '#2563eb' : '#ffffff'};
        color:${active ? '#ffffff' : '#64748b'};transition:all 0.15s;display:inline-flex;align-items:center;gap:6px;
      ">${label} <span style="font-size:11px;padding:1px 6px;border-radius:10px;background:${active ? 'rgba(255,255,255,0.2)' : '#f1f5f9'};color:${active ? '#fff' : '#475569'};">${count}</span></button>`;
    }

    function statusFilterChip(key, label, count, color) {
      const active = activeStatus === key;
      return `<div class="chip" data-status-filter="${key}" style="
        padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;
        border:1px solid ${active ? color : '#e2e8f0'};background:${active ? color : '#ffffff'};
        color:${active ? '#ffffff' : '#475569'};transition:all 0.15s;display:inline-flex;align-items:center;gap:6px;
      ">${label} <span style="font-size:10.5px;opacity:0.9;">(${count})</span></div>`;
    }

    function statusPill(status) {
      const map = {
        requested: { label: 'Requested', bg: '#eff6ff', color: '#2563eb' },
        approved: { label: 'Approved', bg: '#ecfdf5', color: '#059669' },
        testing: { label: 'In Progress', bg: '#fffbeb', color: '#d97706' },
        in_progress: { label: 'In Progress', bg: '#fffbeb', color: '#d97706' },
        review: { label: 'In Review', bg: '#fffbeb', color: '#d97706' },
        completed: { label: 'Completed', bg: '#f5f3ff', color: '#7c3aed' },
      };
      const s = map[status] || { label: status || 'Requested', bg: '#f1f5f9', color: '#64748b' };
      return `<span style="font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:20px;background:${s.bg};color:${s.color};">${s.label}</span>`;
    }

    main.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;">

        <!-- MODULE TABS -->
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid #f1f5f9;">
          ${moduleTabBtn('all', '📋 All Modules', counts.all)}
          ${moduleTabBtn('crf', '📄 Change Requests (CRF)', counts.crf)}
          ${moduleTabBtn('open_enrollment', '📅 Open Enrollment', counts.open_enrollment)}
          ${moduleTabBtn('termination', '👤 Termination', counts.termination)}
          ${moduleTabBtn('implementation', '👥 Implementation', counts.implementation)}
        </div>

        <!-- STATUS FILTER CHIPS -->
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:12px;font-weight:700;color:#64748b;">Filter by Status:</span>
          ${statusFilterChip('all', 'All Records', counts.all, '#2563eb')}
          ${statusFilterChip('requested', '📋 Requested', counts.requested, '#2563eb')}
          ${statusFilterChip('approved', '✅ Approved', counts.approved, '#059669')}
          ${statusFilterChip('testing', '⚡ In Review / Testing', counts.testing, '#d97706')}
          ${statusFilterChip('completed', '🏁 Completed', counts.completed, '#7c3aed')}
        </div>

        <!-- DATE FIELD & YEAR FILTER DROPDOWNS -->
        <div class="year-filter-row" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--surface-alt);padding:12px 18px;border-radius:12px;border:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12.5px;font-weight:700;color:var(--ink-soft);">📅 Filter Date Field:</span>
            <select id="tracker-date-field-select" style="padding:6px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:12.5px;font-weight:600;background:#fff;color:var(--ink);outline:none;cursor:pointer;">
              <option value="any" ${selectedDateField === 'any' ? 'selected' : ''}>Any Date Field</option>
              <option value="received" ${selectedDateField === 'received' ? 'selected' : ''}>Receive / Request Date</option>
              <option value="completed" ${selectedDateField === 'completed' ? 'selected' : ''}>Completion / Effective Date</option>
              <option value="updated" ${selectedDateField === 'updated' ? 'selected' : ''}>Updated / Created Date</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12.5px;font-weight:700;color:var(--ink-soft);">Year:</span>
            <select id="tracker-year-select" style="padding:6px 12px;border-radius:8px;border:1.5px solid var(--border);font-size:12.5px;font-weight:600;background:#fff;color:var(--ink);outline:none;cursor:pointer;">
              <option value="all" ${selectedYear === 'all' ? 'selected' : ''}>All Years</option>
              ${years.map(y => `<option value="${y}" ${String(selectedYear) === String(y) ? 'selected' : ''}>${y}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;">
            <div class="year-chip ${selectedYear === 'all' ? 'active' : ''}" data-tracker-year="all">All Years</div>
            ${years.map(y => `<div class="year-chip ${String(selectedYear) === String(y) ? 'active' : ''}" data-tracker-year="${y}">${y}</div>`).join('')}
          </div>
        </div>

        <!-- RECORDS TABLE -->
        <div class="mockup-card" style="padding:0;overflow:hidden;border-radius:16px;border:1px solid #e2e8f0;background:#ffffff;">
          ${filtered.length === 0 ? `
            <div style="text-align:center;padding:50px;color:#94a3b8;font-size:14.5px;">
              📭 No matching records found. Create new submissions from the workspace tabs above.
            </div>
          ` : `
            <div style="overflow-x:auto;">
              <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                  <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;">
                    <th style="padding:12px 16px;color:#64748b;">Type</th>
                    <th style="padding:12px 16px;color:#64748b;">Client Name</th>
                    <th style="padding:12px 16px;color:#64748b;">Broker Partner</th>
                    <th style="padding:12px 16px;color:#64748b;">Status</th>
                    <th style="padding:12px 16px;color:#64748b;">Analyst / Owner</th>
                    <th style="padding:12px 16px;color:#64748b;">Updated Date</th>
                    <th style="padding:12px 16px;color:#64748b;text-align:right;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map(r => `
                    <tr data-open="${r.id}" style="border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background .15s;"
                        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                      <td style="padding:12px 16px;">
                        <span style="font-size:12px;font-weight:700;padding:3px 10px;border-radius:6px;background:#eff6ff;color:#2563eb;">
                          ${typeLabelOf(r.type)}
                        </span>
                      </td>
                      <td style="padding:12px 16px;font-weight:700;color:#1e293b;">${esc(r.client || 'Untitled')}</td>
                      <td style="padding:12px 16px;color:#475569;">${esc(r.broker || '—')}</td>
                      <td style="padding:12px 16px;">${statusPill(r.status)}</td>
                      <td style="padding:12px 16px;color:#475569;">${esc(r.configAnalyst || r.testingAnalyst || r.implementationManager || '—')}</td>
                      <td style="padding:12px 16px;color:#64748b;">${fmtDate(r.updatedAt || r.createdAt)}</td>
                      <td style="padding:12px 16px;text-align:right;">
                        <button class="btn btn-ghost btn-sm" style="font-size:11.5px;padding:4px 12px;color:#2563eb;font-weight:700;border:1px solid #bfdbfe;background:#eff6ff;"
                                data-open="${r.id}" onclick="event.stopPropagation();if(window.openSubmission)window.openSubmission('${r.id}');">
                          View Details →
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

      </div>
    `;

    // Wire module tabs
    main.querySelectorAll('[data-ttab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.trackerTab = btn.dataset.ttab;
        renderTrackerTable(main);
      });
    });

    // Wire status filters
    main.querySelectorAll('[data-status-filter]').forEach(chip => {
      chip.addEventListener('click', () => {
        state.trackerStatusFilter = chip.dataset.statusFilter;
        renderTrackerTable(main);
      });
    });

    // Wire Date Field Select
    const dateSelect = main.querySelector('#tracker-date-field-select');
    if (dateSelect) {
      dateSelect.addEventListener('change', () => {
        state.trackerDateFieldFilter = dateSelect.value;
        renderTrackerTable(main);
      });
    }

    // Wire Year Select
    const yearSelect = main.querySelector('#tracker-year-select');
    if (yearSelect) {
      yearSelect.addEventListener('change', () => {
        state.trackerYearFilter = yearSelect.value;
        renderTrackerTable(main);
      });
    }

    // Wire year filter chips
    main.querySelectorAll('[data-tracker-year]').forEach(chip => {
      chip.addEventListener('click', () => {
        state.trackerYearFilter = chip.dataset.trackerYear;
        renderTrackerTable(main);
      });
    });

    // Wire row clicks
    main.querySelectorAll('[data-open]').forEach(row => {
      row.addEventListener('click', () => {
        openSubmission(row.dataset.open);
      });
    });
  }

  // ---------------- Admin ----------------
  let isAdminAuthenticated = false;

  async function renderAdmin(main) {
    if (!isAdminAuthenticated) {
      main.innerHTML = `
        <div style="max-width:400px;margin:80px auto;padding:30px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
          <h2 style="margin-top:0;font-family:'Space Grotesk',sans-serif;">Admin Login</h2>
          <div class="field"><label>Username</label><input type="text" id="admin-user" class="form-control"></div>
          <div class="field" style="margin-top:16px;"><label>Password</label><input type="password" id="admin-pass" class="form-control"></div>
          <button class="btn btn-primary" style="width:100%;margin-top:24px;" id="admin-login-btn">Login</button>
        </div>
      `;
      main.querySelector('#admin-login-btn').addEventListener('click', () => {
        const u = main.querySelector('#admin-user').value;
        const p = main.querySelector('#admin-pass').value;
        if (u === 'Kiran' && p === 'WFJ@1234') {
          isAdminAuthenticated = true;
          renderAdmin(main);
        } else {
          alert('Invalid credentials');
        }
      });
      return;
    }

    main.innerHTML = `<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>`;
    let teams = [];
    try {
      teams = await api('/api/admin/teams');
    } catch (e) {
      main.innerHTML = `<div class="empty-state">Failed to load teams: ${e.message}</div>`;
      return;
    }

    main.innerHTML = `
      <div style="font-weight:700;font-size:20px;font-family:'Space Grotesk',sans-serif;margin-bottom:20px;">Admin & Teams</div>
      <div class="hint" style="margin-bottom:20px;">Manage team members. These members will appear in the assignment dropdowns across the application. Note that schema definitions may require a refresh to propagate everywhere.</div>
      
      <div class="card-grid" style="display:block;">
        ${teams.map(t => `
          <div class="section-card" style="margin-bottom:16px;">
            <div class="section-head"><div class="section-title">${esc(t.name)}</div></div>
            <div class="section-body" style="padding:0;">
              <table class="data-table">
                <thead><tr><th>Name</th><th>Email</th><th width="80"></th></tr></thead>
                <tbody>
                  ${t.members.map(m => `
                    <tr>
                      <td>${esc(m.name)}</td>
                      <td>${esc(m.email)}</td>
                      <td><button class="btn btn-ghost btn-sm" onclick="window.deleteMember('${m.id}')">Delete</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
              <div style="padding:12px;background:#f9fafb;border-top:1px solid var(--border);display:flex;gap:8px;">
                <input type="text" id="add-name-${t.id}" placeholder="Name" class="form-control" style="flex:1;padding:6px 10px;">
                <input type="email" id="add-email-${t.id}" placeholder="Email" class="form-control" style="flex:2;padding:6px 10px;">
                <button class="btn btn-primary btn-sm" onclick="window.addMember('${t.id}')">Add Member</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    window.deleteMember = async (id) => {
      if (!confirm('Remove this member?')) return;
      await api('/api/admin/members/' + id, { method: 'DELETE' });
      schema = await loadSchema();
      renderAdmin(main);
    };

    window.addMember = async (teamId) => {
      const name = document.getElementById('add-name-' + teamId).value;
      const email = document.getElementById('add-email-' + teamId).value;
      if (!name || !email) return alert('Name and email required');
      await api('/api/admin/teams/' + teamId + '/members', { method: 'POST', body: JSON.stringify({ name, email }) });
      schema = await loadSchema();
      renderAdmin(main);
    };
  }

  // ---------------- Boot ----------------

  async function init() {
    try {
      [schema, state.index] = await Promise.all([loadSchema(), loadIndex()]);
    } catch (err) {
      console.warn('Backend server not reachable, using offline preview mode:', err);
      state.isOffline = true;
      if (typeof TERMINATION_SECTIONS !== 'undefined') {
        schema = {
          TERMINATION_SECTIONS,
          CRF_SECTIONS,
          CATEGORY_MATRIX,
          CATEGORY_OPTIONS,
          TRACKING_FIELDS,
          TEAM_NAMES: typeof TEAM_NAMES !== 'undefined' ? TEAM_NAMES : [],
          IMPLEMENTATION_FIELDS,
          TERMINATION_EXTRA_FIELDS,
          TEAMS: [],
          STAGES: [
            { key: 'requested', label: 'Requested' },
            { key: 'in_progress', label: 'In Progress' },
            { key: 'review', label: 'In Review' },
            { key: 'completed', label: 'Completed' }
          ]
        };
      }
      try {
        state.index = JSON.parse(localStorage.getItem('wfj_offline_index') || '[]');
      } catch (e) {
        state.index = [];
      }
    }
    render();
  }
  init();
})();

