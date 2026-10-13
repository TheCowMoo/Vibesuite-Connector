(function () {
  'use strict';

  var state = { connections: [] };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      });
    });
  }

  function toast(message, type) {
    type = type || 'info';
    var glyph = type === 'success' ? 'check' : (type === 'error' ? 'alert' : 'info');
    var t = document.createElement('div');
    t.className = 'toast toast--' + type;
    t.innerHTML = icon(glyph) + '<span class="toast__msg"></span>' + '<button class="toast__close" aria-label="Dismiss">' + icon('x') + '</button>';
    t.querySelector('.toast__msg').textContent = message;
    t.querySelector('.toast__close').addEventListener('click', function () { dismissToast(t); });
    $('#toasts').appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    setTimeout(function () { dismissToast(t); }, 3400);
  }
  function dismissToast(t) {
    t.classList.remove('is-visible');
    setTimeout(function () { t.remove(); }, 200);
  }

  /* ---- Navigation ---- */
  function showView(name) {
    if (name === 'team' && authState.enabled && !isAdmin()) name = 'connections';
    if (name === 'senders' && authState.enabled && !isAdmin()) name = 'connections';
    if (name === 'advisor' && authState.enabled && !isAdmin()) name = 'connections';
    $$('.topnav__link').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === name); });
    $('#view-connections').hidden = name !== 'connections';
    $('#view-lists').hidden = name !== 'lists';
    $('#view-knowledge').hidden = name !== 'knowledge';
    $('#view-invites').hidden = name !== 'invites';
    $('#view-attendance').hidden = name !== 'attendance';
    $('#view-advisor').hidden = name !== 'advisor';
    $('#view-campaigns').hidden = name !== 'campaigns';
    $('#view-senders').hidden = name !== 'senders';
    $('#view-team').hidden = name !== 'team';
    $('#view-settings').hidden = name !== 'settings';
    if (name === 'settings') loadInfo();
    if (name === 'lists') loadLists();
    if (name === 'knowledge') loadKnowledge();
    if (name === 'invites') loadInvitesView();
    if (name === 'attendance') loadAttendance();
    if (name === 'advisor') loadAdvisor();
    if (name === 'campaigns') loadCampaigns();
    if (name === 'senders') loadSenders();
    if (name === 'team') loadTeam();
  }
  $$('.topnav__link').forEach(function (btn) {
    btn.addEventListener('click', function () { showView(btn.dataset.view); });
  });

  /* ---- Status helpers ---- */
  var STATUS = {
    active: { label: 'Working', cls: 'chip--success' },
    pending_google: { label: 'Waiting for Google', cls: 'chip--warning' },
    disconnected: { label: 'Not connected', cls: 'chip--neutral' }
  };
  function statusChip(status) {
    var s = STATUS[status] || { label: status, cls: 'chip--neutral' };
    return '<span class="chip ' + s.cls + '">' + esc(s.label) + '</span>';
  }
  function badge(label) {
    return '<span class="badge">' + esc(label) + '</span>';
  }

  /* ---- Icons (monoline, no emoji) ---- */
  var ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="2.5"/></svg>'
  };
  function icon(name) { return ICONS[name] || ''; }
  function menuBtn(action, label, glyph, id, danger) {
    return '<button class="menu__item' + (danger ? ' menu__item--danger' : '') + '" data-action="' + action + '" data-id="' + esc(id) + '">' + icon(glyph) + '<span>' + esc(label) + '</span></button>';
  }
  function skeletonCards(n) {
    var out = '';
    for (var i = 0; i < (n || 3); i++) out += '<div class="skeleton skel-card"></div>';
    return out;
  }
  function withBusy(btn, promise) {
    if (!btn) return promise;
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('btn--busy');
    btn.innerHTML = '<span class="spinner"></span>';
    return promise.finally(function () {
      btn.disabled = false;
      btn.classList.remove('btn--busy');
      btn.innerHTML = original;
    });
  }

  /* ---- Stats ---- */
  function renderStats() {
    var cs = state.connections;
    var items = [
      { label: 'Active', value: cs.filter(function (c) { return c.status === 'active'; }).length, tone: 'success' },
      { label: 'Awaiting Google', value: cs.filter(function (c) { return c.status === 'pending_google'; }).length, tone: 'warning' },
      { label: 'Disconnected', value: cs.filter(function (c) { return c.status === 'disconnected'; }).length, tone: 'neutral' },
      { label: 'Total', value: cs.length, tone: 'navy' }
    ];
    $('#stats').innerHTML = items.map(function (it) {
      return '<div class="stat stat--' + it.tone + '"><div class="stat__value">' + it.value + '</div><div class="stat__label">' + it.label + '</div></div>';
    }).join('');
  }

  /* ---- List ---- */
  function renderList() {
    var list = $('#list');
    var empty = $('#empty');
    var cs = state.connections;
    empty.hidden = cs.length !== 0;
    list.innerHTML = '';

    cs.forEach(function (c) {
      var googleAuth = c.googleAuthType === 'service_account' ? 'Service account' : 'OAuth';
      var ghlAuth = c.ghlAuthType === 'api_token' ? 'API token' : 'OAuth';

      var primary = '';
      if (c.status === 'pending_google') {
        primary = '<a class="btn btn--accent btn--sm" href="/oauth/google/start?connectionId=' + encodeURIComponent(c.id) + '">Connect Google</a>';
      }

      var items = '';
      items += '<a class="menu__item" href="/oauth/google/start?connectionId=' + encodeURIComponent(c.id) + '">' + icon('calendar') + '<span>Reconnect Google</span></a>';
      if (c.ghlAuthType === 'oauth') {
        items += '<a class="menu__item" href="/oauth/ghl/start?connectionId=' + encodeURIComponent(c.id) + '">' + icon('link') + '<span>Connect GHL</span></a>';
      }
      items += menuBtn('attendanceAutomations', 'Attendance automations', 'sliders', c.id);
      items += menuBtn('delete', 'Delete', 'trash', c.id, true);

      var card = document.createElement('div');
      card.className = 'conn';
      card.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(c.name) + '</span>' + statusChip(c.status) + '</div>' +
          '<div class="conn__meta">' +
            '<span class="conn__cal">' + icon('calendar') + esc(c.googleCalendarId) + '</span>' +
            badge('Google · ' + googleAuth) + badge('GHL · ' + ghlAuth) +
          '</div>' +
        '</div>' +
        '<div class="conn__actions">' +
          primary +
          '<button class="btn btn--outline btn--sm" data-action="detail" data-id="' + esc(c.id) + '">Details</button>' +
          '<button class="btn btn--outline btn--sm" data-action="edit" data-id="' + esc(c.id) + '">Edit</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="automations" data-id="' + esc(c.id) + '">Automations</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="bootstrap" data-id="' + esc(c.id) + '">Bootstrap</button>' +
          '<div class="menu-wrap">' +
            '<button class="btn btn--menu btn--sm" data-menu-btn aria-label="More actions" aria-haspopup="menu" title="More actions">' + icon('more') + '</button>' +
            '<div class="menu" data-menu role="menu">' + items + '</div>' +
          '</div>' +
        '</div>';
      list.appendChild(card);
    });
  }

  /* ---- Load ---- */
  function load() {
    $('#stats').innerHTML = '<div class="skeleton skel-stat"></div><div class="skeleton skel-stat"></div><div class="skeleton skel-stat"></div><div class="skeleton skel-stat"></div>';
    $('#list').innerHTML = skeletonCards(3);
    return api('/api/connections').then(function (data) {
      state.connections = data.connections || [];
      renderStats();
      renderList();
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /* ---- Wizard ---- */
  var WIZARD_STEPS = 3;
  var wizardStep = 1;

  function setWizardStep(n) {
    wizardStep = n;
    $$('.step').forEach(function (s) { s.classList.toggle('is-active', Number(s.dataset.step) === n); });
    $$('.step-panel').forEach(function (p) { p.hidden = Number(p.dataset.panel) !== n; });
    $('#wizardBack').hidden = n === 1;
    $('#wizardNext').textContent = n === WIZARD_STEPS ? 'Create connection' : 'Next';
    var checked = $('input[name="ghlAuthType"]:checked');
    $('#ghlTokenField').hidden = checked && checked.value === 'oauth';
  }

  function openWizard() {
    $('#wizardForm').reset();
    setWizardStep(1);
    openModal('wizard');
  }

  $$('input[name="ghlAuthType"]').forEach(function (r) {
    r.addEventListener('change', function () {
      $('#ghlTokenField').hidden = r.checked && r.value === 'oauth';
    });
  });

  $('#wizardNext').addEventListener('click', function () {
    var fd = new FormData($('#wizardForm'));
    if (wizardStep === 1 && !fd.get('googleCalendarId')) { toast('Google Calendar ID is required', 'error'); return; }
    if (wizardStep < WIZARD_STEPS) { setWizardStep(wizardStep + 1); return; }

    var ghlAuthType = fd.get('ghlAuthType') || 'api_token';
    var body = {
      name: fd.get('name') || undefined,
      googleCalendarId: fd.get('googleCalendarId'),
      ghlLocationId: fd.get('ghlLocationId') || undefined,
      ghlAuthType: ghlAuthType,
      ghlApiToken: ghlAuthType === 'api_token' ? (fd.get('ghlApiToken') || undefined) : undefined,
      webhookUrls: {
        yes: fd.get('webhookYes') || undefined,
        maybe: fd.get('webhookMaybe') || undefined,
        no: fd.get('webhookNo') || undefined
      }
    };
    api('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('wizard'); toast('Connection created', 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  $('#wizardBack').addEventListener('click', function () { setWizardStep(wizardStep - 1); });

  /* ---- Detail ---- */
  function mappingTable() {
    var rows = [
      ['accepted', 'confirmed', 'rsvp-yes', 'Send the confirmation email', 'success'],
      ['tentative', 'tentative', 'rsvp-maybe', 'Send the follow-up email', 'warning'],
      ['declined', 'cancelled', 'rsvp-no + DND', 'Stop all messages', 'danger'],
      ['needsAction', 'pending', 'rsvp-pending', 'Nothing changes', 'neutral']
    ];
    return '<table class="map"><thead><tr><th>They replied</th><th>GoHighLevel status</th><th>Tags</th><th>What happens next</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><span class="dot dot--' + r[4] + '"></span>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function openDetail(id) {
    var c = state.connections.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var googleAuth = c.googleAuthType === 'service_account' ? 'Service account' : 'OAuth';
    var ghlAuth = c.ghlAuthType === 'api_token' ? 'API token' : 'OAuth';
    var webhooks = c.webhookUrls || {};
    var rows = [
      ['Calendar ID', c.googleCalendarId],
      ['Google auth', googleAuth],
      ['GHL auth', ghlAuth],
      ['GHL location ID', c.ghlLocationId || '—'],
      ['Webhook — Yes', webhooks.yes || '—'],
      ['Webhook — Maybe', webhooks.maybe || '—'],
      ['Webhook — No', webhooks.no || '—'],
      ['Watch expires', c.watchExpiresAt ? new Date(c.watchExpiresAt).toLocaleString() : '—'],
      ['Created', new Date(c.createdAt).toLocaleString()]
    ];
    $('#detailBody').innerHTML =
      '<div class="detail__head">' + esc(c.name) + ' ' + statusChip(c.status) + '</div>' +
      '<table class="kv">' + rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<h3 class="detail__sub">What a reply does in GoHighLevel</h3>' + mappingTable();
    openModal('detail');
  }

  /* ---- Edit ---- */
  var editId = null;

  function openEdit(id) {
    var c = state.connections.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    editId = id;
    var rg = $('#editReconnectGoogle');
    if (rg) rg.href = '/oauth/google/start?connectionId=' + encodeURIComponent(id);
    var f = $('#editForm');
    f.reset();
    $('[name="name"]', f).value = c.name || '';
    $('[name="googleCalendarId"]', f).value = c.googleCalendarId || '';
    $('[name="ghlLocationId"]', f).value = c.ghlLocationId || '';
    var authType = c.ghlAuthType === 'oauth' ? 'oauth' : 'api_token';
    $$('input[name="ghlAuthType"]', f).forEach(function (r) { r.checked = r.value === authType; });
    $('[name="ghlApiToken"]', f).value = '';
    var w = c.webhookUrls || {};
    $('[name="webhookYes"]', f).value = w.yes || '';
    $('[name="webhookMaybe"]', f).value = w.maybe || '';
    $('[name="webhookNo"]', f).value = w.no || '';
    toggleEditToken();
    openModal('edit');
  }

  function toggleEditToken() {
    var checked = $('#editForm input[name="ghlAuthType"]:checked');
    $('#editTokenField').hidden = !checked || checked.value === 'oauth';
  }

  $$('#editForm input[name="ghlAuthType"]').forEach(function (r) {
    r.addEventListener('change', toggleEditToken);
  });

  $('#editSave').addEventListener('click', function () {
    var fd = new FormData($('#editForm'));
    var ghlAuthType = fd.get('ghlAuthType') || 'api_token';
    var body = {
      name: fd.get('name') || undefined,
      googleCalendarId: fd.get('googleCalendarId') || undefined,
      ghlLocationId: fd.get('ghlLocationId') || undefined,
      ghlAuthType: ghlAuthType,
      ghlApiToken: ghlAuthType === 'api_token' ? (fd.get('ghlApiToken') || undefined) : undefined,
      webhookUrls: {
        yes: fd.get('webhookYes') || undefined,
        maybe: fd.get('webhookMaybe') || undefined,
        no: fd.get('webhookNo') || undefined
      }
    };
    api('/api/connections/' + editId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('edit'); toast('Connection updated', 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  /* ---- Automations ---- */
  var automationsId = null;
  var editingRules = [];
  var CATALOG = [];
  var currentScope = 'calendar';
  var currentRulesEl = null;

  function loadCatalog() {
    return api('/api/integrations').then(function (d) {
      CATALOG = d.integrations || [];
    });
  }

  function fieldMeta(fieldKey) {
    for (var i = 0; i < CATALOG.length; i++) {
      if (currentScope && CATALOG[i].scope !== currentScope) continue;
      var found = CATALOG[i].fields.filter(function (f) { return f.key === fieldKey; })[0];
      if (found) return found;
    }
    return null;
  }

  function fieldOperators(fieldKey) {
    var f = fieldMeta(fieldKey);
    return (f && f.operators && f.operators.length) ? f.operators : ['equals'];
  }

  function operatorLabel(op) { return op.replace(/_/g, ' '); }

  function newRule() {
    var defaultField = currentScope === 'attendance' ? 'attendanceStatus' : 'responseStatus';
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: '',
      enabled: true,
      conditions: [{ field: defaultField, operator: 'equals', value: '' }],
      webhookUrl: ''
    };
  }

  function openAutomations(id) {
    var c = state.connections.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    automationsId = id;
    editingRules = (c.rules || []).map(function (r) { return JSON.parse(JSON.stringify(r)); });
    currentScope = 'calendar';
    currentRulesEl = $('#rulesList');

    var mode = c.ghlDeliveryMode || 'both';
    $$('#automationsBody input[name="deliveryMode"]').forEach(function (r) { r.checked = r.value === mode; });

    (CATALOG.length ? Promise.resolve() : loadCatalog()).then(function () {
      renderRules();
      loadSnapshot(id);
      openModal('automations');
    });
  }

  function renderRules() {
    var el = currentRulesEl || $('#rulesList');
    var rules = editingRules;
    el.innerHTML = '';
    if (rules.length === 0) {
      el.innerHTML = '<p class="muted">No rules yet — add one below.</p>';
    }
    rules.forEach(function (rule) { el.appendChild(ruleEl(rule)); });
  }

  function ruleEl(rule) {
    var box = document.createElement('div');
    box.className = 'rule';

    var head = document.createElement('div');
    head.className = 'rule__head';

    var title = document.createElement('span');
    title.className = 'rule__title';
    title.textContent = 'Rule';

    var en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = !!rule.enabled;
    en.title = 'Enabled';
    en.addEventListener('change', function () { rule.enabled = en.checked; });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = 'Delete rule';
    del.addEventListener('click', function () {
      editingRules = editingRules.filter(function (r) { return r.id !== rule.id; });
      renderRules();
    });

    head.appendChild(title);
    head.appendChild(en);
    head.appendChild(del);
    box.appendChild(head);

    var nameLabel = document.createElement('label');
    nameLabel.className = 'field';
    nameLabel.innerHTML = '<span class="field__label">Rule name</span>';
    var nameInput = document.createElement('input');
    nameInput.value = rule.name || '';
    nameInput.placeholder = 'e.g. Webinar accepted';
    nameInput.addEventListener('input', function () { rule.name = nameInput.value; });
    nameLabel.appendChild(nameInput);
    box.appendChild(nameLabel);

    var condTitle = document.createElement('p');
    condTitle.className = 'rule__cond-title';
    condTitle.textContent = 'When ALL of these match:';
    box.appendChild(condTitle);

    var condList = document.createElement('div');
    condList.className = 'cond-list';
    rule.conditions.forEach(function (cond, idx) {
      condList.appendChild(conditionEl(rule, cond, idx));
    });
    box.appendChild(condList);

    var addCond = document.createElement('button');
    addCond.type = 'button';
    addCond.className = 'btn btn--ghost btn--sm';
    addCond.textContent = '+ Add condition';
    addCond.addEventListener('click', function () {
      rule.conditions.push({ field: currentScope === 'attendance' ? 'attendanceStatus' : 'responseStatus', operator: 'equals', value: '' });
      renderRules();
    });
    box.appendChild(addCond);

    var urlLabel = document.createElement('label');
    urlLabel.className = 'field';
    urlLabel.innerHTML = '<span class="field__label">Then fire this webhook</span>';
    var urlInput = document.createElement('input');
    urlInput.value = rule.webhookUrl || '';
    urlInput.placeholder = 'https://services.leadconnectorhq.com/hooks/…';
    urlInput.addEventListener('input', function () { rule.webhookUrl = urlInput.value; });
    urlLabel.appendChild(urlInput);
    box.appendChild(urlLabel);

    return box;
  }

  function conditionEl(rule, cond, idx) {
    var row = document.createElement('div');
    row.className = 'cond';

    var fieldSel = document.createElement('select');
    CATALOG.forEach(function (integration) {
      if (currentScope && integration.scope !== currentScope) return;
      var og = document.createElement('optgroup');
      og.label = integration.label;
      integration.fields.forEach(function (f) {
        var o = document.createElement('option');
        o.value = f.key;
        o.textContent = f.label;
        og.appendChild(o);
      });
      fieldSel.appendChild(og);
    });
    fieldSel.value = cond.field;
    fieldSel.addEventListener('change', function () {
      cond.field = fieldSel.value;
      cond.operator = fieldOperators(cond.field)[0];
      cond.value = '';
      renderRules();
    });

    var opSel = document.createElement('select');
    fieldOperators(cond.field).forEach(function (op) {
      var o = document.createElement('option');
      o.value = op;
      o.textContent = operatorLabel(op);
      opSel.appendChild(o);
    });
    opSel.value = cond.operator;
    opSel.addEventListener('change', function () { cond.operator = opSel.value; });

    var meta = fieldMeta(cond.field);
    var valueControl;
    if (meta && meta.values) {
      valueControl = document.createElement('select');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— pick value —';
      valueControl.appendChild(blank);
      meta.values.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        valueControl.appendChild(o);
      });
      valueControl.value = cond.value || '';
      valueControl.addEventListener('change', function () { cond.value = valueControl.value; });
    } else {
      valueControl = document.createElement('input');
      valueControl.value = cond.value || '';
      valueControl.placeholder = meta && meta.sample ? 'e.g. ' + meta.sample : 'value';
      valueControl.addEventListener('input', function () { cond.value = valueControl.value; });
    }

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = 'Remove condition';
    del.addEventListener('click', function () {
      rule.conditions.splice(idx, 1);
      renderRules();
    });

    row.appendChild(fieldSel);
    row.appendChild(opSel);
    row.appendChild(valueControl);
    row.appendChild(del);
    return row;
  }

  function loadSnapshot(id) {
    var el = $('#snapshot');
    el.textContent = 'Loading…';
    api('/api/connections/' + id + '/snapshot')
      .then(function (d) {
        el.textContent = d.snapshot ? JSON.stringify(d.snapshot, null, 2) : 'Nothing yet — change a reply in Google Calendar and an example will appear here.';
      })
      .catch(function () { el.textContent = 'No sample available.'; });
  }

  $('#addRuleBtn').addEventListener('click', function () {
    editingRules.push(newRule());
    renderRules();
  });

  $('#automationsSave').addEventListener('click', function () {
    var checked = $('#automationsBody input[name="deliveryMode"]:checked');
    var mode = (checked && checked.value) || 'both';
    var body = { ghlDeliveryMode: mode, rules: editingRules };
    api('/api/connections/' + automationsId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('automations'); toast('Automations saved', 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  /* ---- List actions (event delegation) ---- */
  $('#list').addEventListener('click', function (e) {
    var menuBtn = e.target.closest('[data-menu-btn]');
    if (menuBtn) { e.stopPropagation(); toggleMenu(menuBtn); return; }
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;
    closeAllMenus();
    if (action === 'bootstrap') {
      withBusy(btn, api('/api/connections/' + id + '/bootstrap', { method: 'POST' }))
        .then(function () { toast('Setup started', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (action === 'detail') {
      openDetail(id);
    } else if (action === 'edit') {
      openEdit(id);
    } else if (action === 'automations') {
      openAutomations(id);
    } else if (action === 'attendanceAutomations') {
      openAttendanceAutomations(id);
    } else if (action === 'delete') {
      confirmDialog('Delete connection?', 'This connection and its watch channel will be removed. Its Google watch channel expires on its own.', 'Delete').then(function (ok) {
        if (!ok) return;
        api('/api/connections/' + id, { method: 'DELETE' })
          .then(function () { toast('Connection deleted', 'success'); return load(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  /* ---- Invites ---- */
  var inviteConnections = [];
  var inviteLists = [];
  var inviteRecipientCount = 0;

  function inviteChip(status) {
    if (status === 'sent') return '<span class="chip chip--success">Sent</span>';
    if (status === 'partial') return '<span class="chip chip--warning">Partial</span>';
    if (status === 'failed') return '<span class="chip chip--danger">Failed</span>';
    return '<span class="chip chip--neutral">' + esc(status) + '</span>';
  }

  function relativeTime(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.round(h / 24);
    if (d < 30) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    return new Date(ts).toLocaleDateString();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function pill(label, value, tone) {
    return '<span class="pill pill--' + tone + '">' + value + ' ' + esc(label) + '</span>';
  }

  function loadInvitesView() {
    var tz = document.getElementById('inviteTimezone');
    if (tz && !tz.value) {
      try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    }
    document.getElementById('inviteHistory').innerHTML = skeletonCards(3);
    return Promise.all([
      api('/api/connections').then(function (d) {
        inviteConnections = (d.connections || []).filter(function (c) { return c.status === 'active'; });
      }),
      api('/api/lists').then(function (d) {
        inviteLists = (d.lists || []).filter(function (l) { return l.hasResult; });
      }),
      loadInviteHistory()
    ]).then(function () {
      renderInvitePrereqs();
      renderInviteConnections();
      renderInviteLists();
      renderInviteEventPreview();
      syncInviteValidity();
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderInviteConnections() {
    var sel = document.getElementById('inviteConnection');
    var prev = sel.value;
    sel.innerHTML = '';
    if (!inviteConnections.length) {
      sel.innerHTML = '<option value="">No active connections</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    inviteConnections.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + ' (' + c.googleCalendarId + ')';
      sel.appendChild(o);
    });
    if (prev && inviteConnections.some(function (c) { return c.id === prev; })) sel.value = prev;
    else if (inviteConnections.length) sel.value = inviteConnections[0].id;
  }

  function renderInviteLists() {
    var sel = document.getElementById('inviteList');
    var prev = sel.value;
    sel.innerHTML = '';
    if (!inviteLists.length) {
      sel.innerHTML = '<option value="">No contact lists ready yet</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">Select a list…</option>';
    inviteLists.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.name;
      sel.appendChild(o);
    });
    if (prev && inviteLists.some(function (l) { return l.id === prev; })) sel.value = prev;
  }

  function selectedInviteSegments() {
    var all = document.getElementById('inviteSegAll');
    if (all && all.checked) return [];
    return $$('#inviteSegments .invite-seg:checked').map(function (cb) { return cb.value; });
  }

  function renderInviteSegments(result) {
    var wrap = document.getElementById('inviteSegments');
    wrap.innerHTML = '';
    var segs = (result && Array.isArray(result.segments)) ? result.segments : [];
    if (!segs.length) {
      wrap.innerHTML = '<p class="muted">This list has no segments yet — run Segment first.</p>';
      return;
    }
    var box = document.createElement('div');
    box.className = 'seg-pick';
    var all = document.createElement('label');
    all.className = 'seg-pick__row seg-pick__all';
    all.innerHTML = '<input type="checkbox" id="inviteSegAll" checked /> <span class="seg-pick__name">All segments</span><span class="seg-pick__count">' + segs.length + ' groups</span>';
    box.appendChild(all);
    segs.forEach(function (s) {
      var rows = Array.isArray(s.rows) ? s.rows.length : 0;
      var lab = document.createElement('label');
      lab.className = 'seg-pick__row';
      lab.dataset.seg = s.name;
      lab.innerHTML = '<input type="checkbox" class="invite-seg" value="' + esc(s.name) + '" /> <span class="seg-pick__name">' + esc(s.name) + '</span><span class="seg-pick__count">' + rows + ' rows · <span class="seg-pick__emails"></span></span>';
      box.appendChild(lab);
    });
    wrap.appendChild(box);

    all.querySelector('input').addEventListener('change', function () {
      var on = all.querySelector('input').checked;
      $$('#inviteSegments .invite-seg').forEach(function (cb) { cb.checked = false; cb.disabled = on; });
      $$('#inviteSegments .seg-pick__row[data-seg]').forEach(function (r) { r.classList.toggle('is-disabled', on); });
      refreshInvitePreview();
    });
    $$('#inviteSegments .invite-seg').forEach(function (cb) {
      cb.addEventListener('change', refreshInvitePreview);
    });
  }

  function refreshInvitePreview() {
    var listId = document.getElementById('inviteList').value;
    var el = document.getElementById('inviteRecipients');
    if (!listId) {
      el.innerHTML = '<span class="muted">Pick a contact list to see who will be invited.</span>';
      inviteRecipientCount = 0;
      updateInviteSegmentCounts(null);
      syncInviteValidity();
      return;
    }
    api('/api/invites/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: listId, segments: selectedInviteSegments() }) })
      .then(function (d) {
        inviteRecipientCount = d.emails.length;
        updateInviteSegmentCounts(d.perSegment);
        var html = pill('people', d.emails.length, d.emails.length ? 'ok' : 'danger');
        if (d.duplicatesRemoved) html += pill('duplicates', d.duplicatesRemoved, 'neutral');
        if (d.invalid && d.invalid.length) html += pill('invalid', d.invalid.length, 'warn');
        if (d.alreadyInvited && d.alreadyInvited.length) html += pill('already invited', d.alreadyInvited.length, 'warn');
        if (!d.emails.length) html += ' <span class="muted" style="font-size:0.85rem">Nobody new to invite.</span>';
        el.innerHTML = html;
        syncInviteValidity();
      })
      .catch(function (e) { el.textContent = 'Preview failed: ' + e.message; syncInviteValidity(); });
  }

  function updateInviteSegmentCounts(perSegment) {
    $$('#inviteSegments .seg-pick__row[data-seg]').forEach(function (row) {
      var cnt = row.querySelector('.seg-pick__emails');
      if (!cnt) return;
      if (!perSegment) { cnt.textContent = ''; return; }
      var m = perSegment.filter(function (s) { return s.name === row.dataset.seg; })[0];
      cnt.textContent = m ? (m.emails.length + ' emails') : '0 emails';
    });
  }

  function renderInviteEventPreview() {
    var el = document.getElementById('inviteEventPreview');
    var start = document.getElementById('inviteStart').value;
    var end = document.getElementById('inviteEnd').value;
    var tz = document.getElementById('inviteTimezone').value.trim();
    if (!start || !end) { el.className = 'invite-event-preview'; el.textContent = 'Add a start and end time.'; return; }
    var min = Math.round((new Date(end) - new Date(start)) / 60000);
    if (min <= 0) { el.className = 'invite-event-preview is-invalid'; el.textContent = 'End must be after start.'; return; }
    var fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    var parts = [];
    try { parts.push(fmt.format(new Date(start))); parts.push('–'); parts.push(fmt.format(new Date(end))); } catch (e) {}
    parts.push('· ' + min + ' min');
    if (tz) parts.push('· ' + tz);
    var isPast = new Date(start) < new Date();
    el.className = 'invite-event-preview' + (isPast ? ' is-warn' : '');
    el.textContent = parts.join(' ');
    if (isPast) el.textContent += ' — start is in the past';
  }

  function autoEnd() {
    var start = document.getElementById('inviteStart').value;
    var endEl = document.getElementById('inviteEnd');
    if (!start) return;
    if (endEl.value && endEl.dataset.auto !== '1') return;
    var d = new Date(start);
    if (isNaN(d.getTime())) return;
    d.setMinutes(d.getMinutes() + 60);
    endEl.value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    endEl.dataset.auto = '1';
  }

  function syncInviteValidity() {
    var btn = document.getElementById('inviteSend');
    var reasons = [];
    if (!document.getElementById('inviteConnection').value) reasons.push('a calendar connection');
    if (!document.getElementById('inviteList').value) reasons.push('a contact list');
    if (!document.getElementById('inviteSummary').value.trim()) reasons.push('an event title');
    var start = document.getElementById('inviteStart').value;
    var end = document.getElementById('inviteEnd').value;
    if (!start || !end) reasons.push('start and end times');
    else if (new Date(end) <= new Date(start)) reasons.push('an end after start');
    if (!inviteRecipientCount) reasons.push('people to invite');
    btn.disabled = reasons.length > 0;
    btn.title = reasons.length ? ('Send is disabled — choose ' + reasons.join(', ')) : 'Send invites';
  }

  function renderInviteSummaryStrip(invites) {
    var el = document.getElementById('inviteSummaryStrip');
    var sent = invites.filter(function (i) { return i.status === 'sent' || i.status === 'partial'; }).length;
    var reached = invites.reduce(function (a, i) { return a + (i.recipientCount || 0); }, 0);
    var last = invites.length ? relativeTime(invites[0].createdAt) : '—';
    el.innerHTML =
      '<div class="summary__item"><span class="summary__value">' + sent + '</span><span class="summary__label">invites sent</span></div>' +
      '<div class="summary__item"><span class="summary__value">' + reached + '</span><span class="summary__label">people reached</span></div>' +
      '<div class="summary__item"><span class="summary__value">' + last + '</span><span class="summary__label">last sent</span></div>';
  }

  function renderInviteResult(r) {
    var el = document.getElementById('inviteResult');
    el.hidden = false;
    var links = ((r.invite && r.invite.batches) || []).map(function (b) {
      return b.htmlLink ? '<a href="' + esc(b.htmlLink) + '" target="_blank" rel="noopener">open event</a>' : '';
    }).filter(Boolean).join(', ');
    if (r.ok) {
      el.className = 'invite-result invite-result--success';
      el.innerHTML = 'Sent to ' + r.sent + ' recipient' + (r.sent === 1 ? '' : 's') + (links ? ' — ' + links : '') + '.';
    } else {
      el.className = 'invite-result invite-result--error';
      el.innerHTML = 'Failed: ' + (r.invite && r.invite.error ? esc(r.invite.error) : 'unknown error') + '. ' + r.sent + '/' + (r.sent + r.failed) + ' sent' + (links ? ' — ' + links : '') + '.';
    }
  }

  function renderInvitePrereqs() {
    var pre = document.getElementById('invitePrereqs');
    var composer = document.getElementById('inviteComposer');
    var problem = null;
    if (!inviteConnections.length) {
      problem = { title: 'No active connections', text: 'You need at least one active Google Calendar connection to send invites from.', cta: 'Go to Connections', view: 'connections' };
    } else if (!inviteLists.length) {
      problem = { title: 'No contact lists ready', text: 'Upload your contacts and sort them into groups first, then come back here to invite them.', cta: 'Go to Contact lists', view: 'lists' };
    }
    if (problem) {
      pre.hidden = false;
      composer.hidden = true;
      document.getElementById('invitePrereqsTitle').textContent = problem.title;
      document.getElementById('invitePrereqsText').textContent = problem.text;
      var cta = document.getElementById('invitePrereqsCta');
      cta.textContent = problem.cta;
      cta.hidden = false;
      cta.onclick = function () { showView(problem.view); };
    } else {
      pre.hidden = true;
      composer.hidden = false;
    }
  }

  function loadInviteHistory() {
    return api('/api/invites').then(function (d) { renderInviteHistory(d.invites || []); }).catch(function () {});
  }

  function renderInviteHistory(invites) {
    var el = document.getElementById('inviteHistory');
    renderInviteSummaryStrip(invites);
    if (!invites.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('send') + '</div><h2 class="empty__title">No invitations yet</h2><p class="empty__text">Send your first invitation and it will show up here.</p></div>';
      return;
    }
    var rows = invites.map(function (inv) {
      var links = inv.batches && inv.batches.length
        ? inv.batches.map(function (b) { return b.htmlLink ? '<a class="btn btn--outline btn--sm" href="' + esc(b.htmlLink) + '" target="_blank" rel="noopener">Open event</a>' : ''; }).join(' ')
        : '';
      var err = inv.error ? '<div class="muted" style="font-size:0.75rem; margin-top:0.2rem">' + esc(inv.error) + '</div>' : '';
      return '<tr>' +
        '<td><strong>' + esc(inv.summary) + '</strong><div class="muted" style="font-size:0.8rem">' + esc(inv.listName) + '</div></td>' +
        '<td>' + esc(inv.connectionName) + '</td>' +
        '<td>' + inv.recipientCount + '</td>' +
        '<td>' + inviteChip(inv.status) + err + '</td>' +
        '<td title="' + esc(new Date(inv.createdAt).toLocaleString()) + '">' + relativeTime(inv.createdAt) + '</td>' +
        '<td>' + links + ' <button class="btn btn--ghost btn--sm" data-action="deleteInvite" data-id="' + esc(inv.id) + '" aria-label="Delete invite record">Delete</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table class="map" aria-label="Invite history"><thead><tr><th>What</th><th>Google account</th><th>People</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function goToInvite(listId) {
    showView('invites');
    loadInvitesView().then(function () {
      document.getElementById('inviteList').value = listId || '';
      var list = inviteLists.filter(function (l) { return l.id === listId; })[0];
      if (list) document.getElementById('inviteSummary').value = list.name;
      document.getElementById('inviteList').dispatchEvent(new Event('change'));
    });
  }

  document.getElementById('inviteList').addEventListener('change', function () {
    var id = this.value;
    if (!id) {
      document.getElementById('inviteSegments').innerHTML = '<p class="muted">Choose a list to see its segments.</p>';
      document.getElementById('inviteRecipients').textContent = 'Pick a contact list to see who will be invited.';
      return;
    }
    api('/api/lists/' + id).then(function (d) {
      var list = d.list;
      renderInviteSegments(list && list.result);
      if (!document.getElementById('inviteSummary').value.trim()) {
        document.getElementById('inviteSummary').value = (list && list.name) || '';
      }
      refreshInvitePreview();
    }).catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('invitePreview').addEventListener('click', refreshInvitePreview);

  document.getElementById('inviteDraftAi').addEventListener('click', function () {
    var listId = document.getElementById('inviteList').value;
    withBusy(this, api('/api/invites/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: listId }) }))
      .then(function (d) {
        if (d.summary) document.getElementById('inviteSummary').value = d.summary;
        if (d.description) document.getElementById('inviteDescription').value = d.description;
        toast('Draft ready', 'success');
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('inviteSend').addEventListener('click', function () {
    var connId = document.getElementById('inviteConnection').value;
    var listId = document.getElementById('inviteList').value;
    var summary = document.getElementById('inviteSummary').value.trim();
    var start = document.getElementById('inviteStart').value;
    var end = document.getElementById('inviteEnd').value;
    if (!connId) { toast('Choose a Google account first', 'error'); return; }
    if (!listId) { toast('Choose a contact list', 'error'); return; }
    if (!summary) { toast('Event title is required', 'error'); return; }
    if (!start || !end) { toast('Add a start and end time', 'error'); return; }
    if (new Date(end) <= new Date(start)) { toast('End must be after start', 'error'); return; }

    api('/api/invites/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: listId, segments: selectedInviteSegments() }) })
      .then(function (p) {
        if (!p.emails.length) { toast('Nobody left to invite — they have all been invited already, or the emails are not valid', 'error'); return; }
        return confirmDialog('Send invites?', 'This emails a real calendar invite to ' + p.emails.length + ' recipient(s) via Google Calendar. It cannot be undone.', 'Send')
          .then(function (ok) {
            if (!ok) return;
            var body = {
              connectionId: connId,
              listId: listId,
              segments: selectedInviteSegments(),
              event: {
                summary: summary,
                description: document.getElementById('inviteDescription').value,
                location: document.getElementById('inviteLocation').value,
                start: start,
                end: end,
                timeZone: document.getElementById('inviteTimezone').value || undefined
              }
            };
            return withBusy(document.getElementById('inviteSend'), api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
              .then(function (r) {
                if (r.ok) {
                  toast('Invitations sent (' + r.sent + ' people)', 'success');
                } else {
                  var reason = (r.invite && r.invite.error) ? r.invite.error : "some didn't go through";
                  toast('Invite failed: ' + reason + ' (' + r.sent + '/' + (r.sent + r.failed) + ' sent)', 'error');
                }
                renderInviteResult(r);
                loadInviteHistory();
                refreshInvitePreview();
              })
              .catch(function (e) { toast(e.message, 'error'); });
          });
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('inviteHistory').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="deleteInvite"]');
    if (!btn) return;
    confirmDialog('Delete invite record?', 'This only removes the history entry — the calendar event and invitations remain in Google.', 'Delete').then(function (ok) {
      if (!ok) return;
      api('/api/invites/' + btn.dataset.id, { method: 'DELETE' })
        .then(function () { toast('Record deleted', 'success'); loadInviteHistory(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  });

  document.getElementById('listResultInvite').addEventListener('click', function () {
    if (currentListResultId) goToInvite(currentListResultId);
  });

  document.getElementById('inviteStart').addEventListener('input', function () {
    autoEnd();
    renderInviteEventPreview();
    syncInviteValidity();
  });
  document.getElementById('inviteEnd').addEventListener('input', function () {
    this.dataset.auto = '0';
    renderInviteEventPreview();
    syncInviteValidity();
  });
  document.getElementById('inviteTimezone').addEventListener('input', function () {
    renderInviteEventPreview();
    syncInviteValidity();
  });
  document.getElementById('inviteConnection').addEventListener('change', syncInviteValidity);
  document.getElementById('inviteSummary').addEventListener('input', syncInviteValidity);

  /* ---- Attendance ---- */
  var attendanceSessions = [];
  var currentSessionId = null;

  function sessionChip(status) {
    if (status === 'synced') return '<span class="chip chip--success">Synced</span>';
    if (status === 'failed') return '<span class="chip chip--danger">Failed</span>';
    return '<span class="chip chip--neutral">Pending</span>';
  }

  function providerLabel(p) {
    if (p === 'google_meet') return 'Google Meet';
    if (p === 'webinargeek') return 'WebinarGeek';
    return 'Zoom';
  }

  function loadAttendance() {
    document.getElementById('sessionsList').innerHTML = skeletonCards(3);
    return api('/api/sessions').then(function (d) {
      attendanceSessions = d.sessions || [];
      renderAttendanceSummary(attendanceSessions);
      renderSessions(attendanceSessions);
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderAttendanceSummary(sessions) {
    var el = document.getElementById('attendanceSummaryStrip');
    var synced = sessions.filter(function (s) { return s.status === 'synced'; }).length;
    el.innerHTML =
      '<div class="summary__item"><span class="summary__value">' + sessions.length + '</span><span class="summary__label">sessions</span></div>' +
      '<div class="summary__item"><span class="summary__value">' + synced + '</span><span class="summary__label">synced</span></div>';
  }

  function renderSessions(sessions) {
    var el = document.getElementById('sessionsList');
    el.innerHTML = '';
    if (!sessions.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('video') + '</div><h2 class="empty__title">No video calls yet</h2><p class="empty__text">Add a video call to see who showed up to it.</p><button class="btn btn--accent" id="emptySessionsCta">New video call</button></div>';
      document.getElementById('emptySessionsCta').addEventListener('click', openNewSession);
      return;
    }
    sessions.forEach(function (s) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(s.title) + '</span>' + sessionChip(s.status) + '</div>' +
          '<div class="conn__meta">' +
            '<span class="conn__cal">' + icon('video') + esc(providerLabel(s.provider)) + ' ' + esc(s.sessionType || 'meeting') + ' · ' + esc(s.externalId) + '</span>' +
            badge(new Date(s.startTime).toLocaleString()) +
          '</div>' +
          (s.error ? '<div class="muted" style="font-size:0.8rem">' + esc(s.error) + '</div>' : '') +
        '</div>' +
        '<div class="conn__actions">' +
          '<button class="btn btn--primary btn--sm" data-action="syncSession" data-id="' + esc(s.id) + '">Sync now</button>' +
          '<button class="btn btn--ghost btn--sm" data-action="openSession" data-id="' + esc(s.id) + '">Details</button>' +
          '<button class="btn btn--danger btn--sm" data-action="deleteSession" data-id="' + esc(s.id) + '">Delete</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function syncSession(id) {
    var btn = document.querySelector('#sessionsList [data-action="syncSession"][data-id="' + id + '"]');
    withBusy(btn, api('/api/sessions/' + id + '/sync', { method: 'POST' }))
      .then(function (r) { toast('Attendance synced (' + r.report.attendedCount + ' attended, ' + r.report.noShowCount + ' no-show)', 'success'); loadAttendance(); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function openSession(id) {
    currentSessionId = id;
    api('/api/sessions/' + id).then(function (d) {
      renderSessionDetail(d.session, d.attendance);
      openModal('sessionDetail');
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderSessionDetail(session, attendance) {
    document.getElementById('sessionDetailTitle').textContent = session.title || 'Session';
    var head = '<div class="detail__head">' + esc(session.title) + ' ' + sessionChip(session.status) + '</div>' +
      '<table class="kv">' +
      '<tr><th>Provider</th><td>' + esc(providerLabel(session.provider)) + ' · ' + esc(session.sessionType || 'meeting') + '</td></tr>' +
      '<tr><th>Meeting ID</th><td>' + esc(session.externalId) + '</td></tr>' +
      '<tr><th>Start</th><td>' + new Date(session.startTime).toLocaleString() + '</td></tr>' +
      '<tr><th>End</th><td>' + new Date(session.endTime).toLocaleString() + '</td></tr>' +
      (session.error ? '<tr><th>Error</th><td>' + esc(session.error) + '</td></tr>' : '') +
      '</table>';

    var body = head;
    if (!attendance) {
      body += '<p class="muted">No attendance synced yet — click "Sync now".</p>';
    } else {
      body += '<div class="summary" style="margin:0.5rem 0 1rem">' +
        '<div class="summary__item"><span class="summary__value">' + attendance.invitedCount + '</span><span class="summary__label">invited</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + attendance.attendedCount + '</span><span class="summary__label">attended</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + attendance.noShowCount + '</span><span class="summary__label">no-show</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + Math.round((attendance.attendanceRate || 0) * 100) + '%</span><span class="summary__label">attendance</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + (attendance.registrantCount || 0) + '</span><span class="summary__label">registrants</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + ((attendance.polls || []).length) + '</span><span class="summary__label">polls</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + ((attendance.qa || []).length) + '</span><span class="summary__label">Q&amp;A</span></div>' +
        '</div>';

      var stats = attendance.sessionStats || {};
      var statKeys = Object.keys(stats);
      if (statKeys.length) {
        body += '<h3 class="detail__sub">Session stats</h3><table class="map"><tbody>' +
          statKeys.map(function (k) { return '<tr><th>' + esc(k) + '</th><td>' + esc(stats[k]) + '</td></tr>'; }).join('') +
          '</tbody></table>';
      }

      body += '<h3 class="detail__sub">Attended (' + attendance.attendedCount + ')</h3>' + attendanceTable(attendance.attended);

      body += '<h3 class="detail__sub">No-show (' + attendance.noShowCount + ')</h3>' +
        (attendance.noShow.length ? '<table class="map"><tbody>' + attendance.noShow.map(function (e) { return '<tr><td>' + esc(e) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="muted">None</p>');

      if ((attendance.absentees || []).length) {
        body += '<h3 class="detail__sub">Absentees (' + attendance.absentees.length + ')</h3><table class="map"><tbody>' +
          attendance.absentees.map(function (e) { return '<tr><td>' + esc(e) + '</td></tr>'; }).join('') + '</tbody></table>';
      }
    }
    document.getElementById('sessionDetailBody').innerHTML = body;
  }

  function attendanceTable(people) {
    if (!people.length) return '<p class="muted">None</p>';
    return '<table class="map"><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Duration</th><th>Focus</th><th>Guest</th></tr></thead><tbody>' +
      people.map(function (p) {
        var min = p.durationSec !== undefined ? Math.round(p.durationSec / 60) + ' min' : '—';
        var att = p.attentivenessScore !== undefined ? String(p.attentivenessScore) : '—';
        var guest = p.isGuest === undefined ? '—' : (p.isGuest ? 'yes' : 'no');
        return '<tr><td>' + esc(p.email || '—') + '</td><td>' + esc(p.name || '—') + '</td><td>' + esc(p.status) + '</td><td>' + min + '</td><td>' + att + '</td><td>' + guest + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function dispatchSession() {
    if (!currentSessionId) return;
    withBusy(document.getElementById('sessionDispatch'), api('/api/sessions/' + currentSessionId + '/dispatch', { method: 'POST' }))
      .then(function (r) { toast('Sent to GHL (' + r.dispatched + ' records)', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function openNewSession() {
    document.getElementById('newSessionForm').reset();
    populateSessionSelects();
    openModal('newSession');
  }

  function populateSessionSelects() {
    var connSel = document.getElementById('sessionConnection');
    connSel.innerHTML = '<option value="">None</option>';
    state.connections.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      connSel.appendChild(o);
    });
    api('/api/invites').then(function (d) {
      var invSel = document.getElementById('sessionInvite');
      invSel.innerHTML = '<option value="">None</option>';
      (d.invites || []).forEach(function (i) {
        var o = document.createElement('option');
        o.value = i.id;
        o.textContent = i.summary;
        invSel.appendChild(o);
      });
    }).catch(function () {});
  }

  function saveNewSession() {
    var fd = new FormData(document.getElementById('newSessionForm'));
    var body = {
      provider: fd.get('provider'),
      sessionType: fd.get('sessionType'),
      externalId: fd.get('externalId'),
      title: fd.get('title'),
      startTime: fd.get('startTime'),
      endTime: fd.get('endTime'),
      connectionId: fd.get('connectionId') || undefined,
      inviteId: fd.get('inviteId') || undefined
    };
    if (!body.externalId || !body.title || !body.startTime || !body.endTime) { toast('Meeting ID, title, start and end are required', 'error'); return; }
    api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('newSession'); toast('Session created', 'success'); loadAttendance(); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  document.getElementById('newSessionBtn').addEventListener('click', openNewSession);
  document.getElementById('newSessionSave').addEventListener('click', saveNewSession);
  document.getElementById('sessionDispatch').addEventListener('click', dispatchSession);

  document.getElementById('sessionsList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.action === 'syncSession') syncSession(id);
    else if (btn.dataset.action === 'openSession') openSession(id);
    else if (btn.dataset.action === 'deleteSession') {
      confirmDialog('Delete session?', 'The session and its attendance report will be removed.', 'Delete').then(function (ok) {
        if (!ok) return;
        api('/api/sessions/' + id, { method: 'DELETE' }).then(function () { toast('Session deleted', 'success'); loadAttendance(); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  function openAttendanceAutomations(id) {
    var c = state.connections.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    automationsId = id;
    editingRules = (c.attendanceRules || []).map(function (r) { return JSON.parse(JSON.stringify(r)); });
    currentScope = 'attendance';
    currentRulesEl = document.getElementById('attendanceRulesList');

    var mode = c.attendanceDeliveryMode || 'both';
    $$('#attendanceAutomationsBody input[name="attendanceDeliveryMode"]').forEach(function (r) { r.checked = r.value === mode; });

    (CATALOG.length ? Promise.resolve() : loadCatalog()).then(function () {
      renderRules();
      document.getElementById('attendanceSnapshot').textContent = JSON.stringify({
        sessionId: 'sess_…', provider: 'zoom', title: c.name, email: 'person@example.com', status: 'attended',
        joinedAt: '2026-10-08T13:02:00Z', leftAt: '2026-10-08T13:58:00Z', durationSec: 3360,
        invitedCount: 142, attendedCount: 98, noShowCount: 44, timestamp: new Date().toISOString()
      }, null, 2);
      openModal('attendanceAutomations');
    });
  }

  document.getElementById('attendanceAddRuleBtn').addEventListener('click', function () {
    editingRules.push(newRule());
    renderRules();
  });

  document.getElementById('attendanceAutomationsSave').addEventListener('click', function () {
    var checked = document.querySelector('#attendanceAutomationsBody input[name="attendanceDeliveryMode"]:checked');
    var mode = (checked && checked.value) || 'both';
    var body = { attendanceDeliveryMode: mode, attendanceRules: editingRules };
    api('/api/connections/' + automationsId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('attendanceAutomations'); toast('Attendance automations saved', 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  function videoCard() {
    return '<div class="card"><h3 class="card__title">Video conferencing</h3>' +
      '<p class="muted">Connect Zoom to cross-reference attendance. Google Meet and WebinarGeek are coming soon.</p>' +
      '<label class="field"><span class="field__label">Zoom — Account ID</span><input id="zoomAccountId" /></label>' +
      '<label class="field"><span class="field__label">Zoom — Client ID</span><input id="zoomClientId" /></label>' +
      '<label class="field"><span class="field__label">Zoom — Client secret</span><input id="zoomClientSecret" type="password" placeholder="Leave blank to keep current" /></label>' +
      '<p class="muted" id="videoStatus"></p>' +
      '<div class="conn__actions"><button class="btn btn--ghost btn--sm" id="videoTest">Test</button><button class="btn btn--primary btn--sm" id="videoSave">Save</button></div>' +
      '</div>';
  }

  function wireVideo() {
    api('/api/video/settings').then(function (d) {
      if (d.zoom) {
        document.getElementById('zoomAccountId').value = d.zoom.accountId || '';
        document.getElementById('zoomClientId').value = d.zoom.clientId || '';
        document.getElementById('zoomClientSecret').placeholder = d.zoom.clientSecretMasked ? ('Current: ' + d.zoom.clientSecretMasked) : 'Leave blank to keep current';
        document.getElementById('videoStatus').textContent = 'Zoom configured.';
      } else {
        document.getElementById('videoStatus').textContent = 'Zoom not configured yet.';
      }
    }).catch(function () {});

    document.getElementById('videoSave').addEventListener('click', function () {
      var body = { zoom: {
        accountId: document.getElementById('zoomAccountId').value,
        clientId: document.getElementById('zoomClientId').value,
        clientSecret: document.getElementById('zoomClientSecret').value || undefined
      } };
      withBusy(this, api('/api/video/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
        .then(function () { document.getElementById('zoomClientSecret').value = ''; toast('Video settings saved', 'success'); })
        .catch(function (e) { toast(e.message, 'error'); });
    });

    document.getElementById('videoTest').addEventListener('click', function () {
      withBusy(this, api('/api/video/test', { method: 'POST' }))
        .then(function (r) {
          if (r.ok) { document.getElementById('videoStatus').textContent = 'Zoom connection OK.'; toast('Zoom test OK', 'success'); }
          else { document.getElementById('videoStatus').textContent = 'Test failed — ' + (r.detail || 'unknown'); toast('Zoom test failed: ' + (r.detail || ''), 'error'); }
        })
        .catch(function (e) { toast(e.message, 'error'); });
    });
  }

  /* ---- Settings ---- */
  function loadInfo() {
    $('#settingsCards').innerHTML = '<div class="skeleton skel-card" style="height:180px"></div><div class="skeleton skel-card" style="height:180px"></div>';
    return api('/api/info').then(function (info) {
      $('#settingsCards').innerHTML = aiCard() + videoCard() + securityCard(info) + brandingCard();
      wireAi();
      loadAiSettings();
      wireVideo();
    }).catch(function (err) { $('#settingsCards').innerHTML = '<div class="card"><p class="muted">' + esc(err.message) + '</p></div>'; });
  }
  function brandingCard() {
    return '<div class="card"><h3 class="card__title">Branding</h3>' +
      '<div class="brand-swatch"><img src="/static/logo.png" alt="Vibesuite logo" class="brand-swatch__logo" /></div>' +
      '<p class="muted">Vibesuite — turns Google Calendar replies into GoHighLevel activity.</p></div>';
  }
  function securityCard(info) {
    var ok = !!info.encryptionAtRest;
    var msg = ok
      ? 'Stored credentials are encrypted at rest (AES-256-GCM).'
      : 'CREDENTIALS_ENCRYPTION_KEY is not set — stored tokens are not encrypted.';
    return '<div class="card"><h3 class="card__title">Security</h3>' +
      '<p class="muted"><span class="dot ' + (ok ? 'dot--success' : 'dot--danger') + '"></span>' + esc(msg) + '</p>' +
      '<p class="muted">Google webhooks are validated via per-connection channel tokens.</p></div>';
  }

  /* ---- Lists & Knowledge ---- */
  function loadLists() {
    $('#listsList').innerHTML = skeletonCards(3);
    return api('/api/lists').then(function (d) { renderLists(d.lists || []); }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderLists(lists) {
    var el = $('#listsList');
    el.innerHTML = '';
    if (!lists.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('list') + '</div><h2 class="empty__title">No contact lists yet</h2><p class="empty__text">Upload your contacts and let the AI sort them into groups.</p><button class="btn btn--accent" id="emptyListsCta">New contact list</button></div>';
      $('#emptyListsCta').addEventListener('click', function () { $('#newListForm').reset(); openModal('newList'); });
      return;
    }
    el.innerHTML = '<div class="summary">' +
      '<div class="summary__item"><span class="summary__value">' + lists.length + '</span><span class="summary__label">lists</span></div>' +
      '<div class="summary__item"><span class="summary__value">' + lists.filter(function (l) { return l.hasResult; }).length + '</span><span class="summary__label">sorted</span></div>' +
      '</div>';
    lists.forEach(function (l) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(l.name) + '</span>' + (l.hasResult ? '<span class="chip chip--success">Sorted</span>' : '<span class="chip chip--neutral">Not sorted yet</span>') + '</div>' +
          '<div class="conn__meta"><span>' + esc(l.criteria || 'No criteria') + '</span></div>' +
        '</div>' +
        '<div class="conn__actions">' +
          '<button class="btn btn--primary btn--sm" data-action="segment" data-id="' + esc(l.id) + '">Segment</button>' +
          (l.hasResult ? '<button class="btn btn--accent btn--sm" data-action="sendInvite" data-id="' + esc(l.id) + '">Send invite</button>' : '') +
          '<button class="btn btn--ghost btn--sm" data-action="viewResult" data-id="' + esc(l.id) + '">View</button>' +
          '<button class="btn btn--danger btn--sm" data-action="deleteList" data-id="' + esc(l.id) + '">Delete</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function segmentList(id) {
    var btn = $('#listsList [data-action="segment"][data-id="' + id + '"]');
    withBusy(btn, api('/api/lists/' + id + '/segment', { method: 'POST' }))
      .then(function () { toast('Sorted into groups', 'success'); loadLists(); viewListResult(id); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  var currentListResultId = null;
  function viewListResult(id) {
    currentListResultId = id;
    api('/api/lists/' + id).then(function (d) {
      var r = d.list && d.list.result;
      $('#listResultBody').innerHTML = renderSegments(r);
      openModal('listResult');
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderSegments(result) {
    if (!result) return '<p class="muted">No result yet — run Segment first.</p>';
    var segs = result.segments;
    if (!Array.isArray(segs) || !segs.length) {
      return '<pre class="snapshot">' + esc(JSON.stringify(result, null, 2)) + '</pre>';
    }
    return segs.map(function (seg, i) {
      var rows = Array.isArray(seg.rows) ? seg.rows : [];
      var keys = (rows.length && typeof rows[0] === 'object') ? Object.keys(rows[0]) : [];
      var table = '';
      if (keys.length) {
        table = '<table class="map"><thead><tr>' +
          keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (row) {
            return '<tr>' + keys.map(function (k) {
              var v = row[k];
              return '<td>' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v == null ? '' : v)) + '</td>';
            }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
      }
      return '<div class="seg" data-open="false">' +
        '<div class="seg__head"><span class="seg__chev">' + icon('chevron') + '</span><span class="seg__name">' + esc(seg.name || ('Segment ' + (i + 1))) + '</span><span class="seg__count">' + rows.length + ' rows</span></div>' +
        '<div class="seg__reason">' + esc(seg.reason || '') + '</div>' +
        '<div class="seg__rows">' + table + '</div>' +
        '</div>';
    }).join('');
  }

  function loadKnowledge() {
    $('#knowledgeList').innerHTML = skeletonCards(3);
    return api('/api/knowledge').then(function (d) { renderKnowledge(d.docs || []); }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderKnowledge(docs) {
    var el = $('#knowledgeList');
    el.innerHTML = '';
    if (!docs.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('book') + '</div><h2 class="empty__title">No documents yet</h2><p class="empty__text">Add notes the AI can read before it writes for you.</p><button class="btn btn--accent" id="emptyKnowledgeCta">Add document</button></div>';
      $('#emptyKnowledgeCta').addEventListener('click', function () { $('#newKnowledgeForm').reset(); openModal('newKnowledge'); });
      return;
    }
    docs.forEach(function (d) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(d.name) + '</span></div>' +
          '<div class="conn__meta"><span>' + d.size + ' chars</span></div>' +
          (d.snippet ? '<p class="snippet">' + esc(d.snippet) + '</p>' : '') +
        '</div>' +
        '<div class="conn__actions"><button class="btn btn--danger btn--sm" data-action="deleteKnowledge" data-id="' + esc(d.id) + '">Delete</button></div>';
      el.appendChild(box);
    });
  }

  function readFileText(file, textarea) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { textarea.value = String(reader.result || ''); };
    reader.readAsText(file);
  }

  function wireDropzone(dropId, inputId, fileNameId, textareaSel) {
    var drop = $('#' + dropId);
    var input = $('#' + inputId);
    var nameEl = $('#' + fileNameId);
    if (!drop || !input) return;
    input.addEventListener('change', function () {
      readFileText(input.files && input.files[0], $(textareaSel));
      if (nameEl) nameEl.textContent = (input.files && input.files[0]) ? input.files[0].name : '';
    });
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      readFileText(f, $(textareaSel));
      if (nameEl) nameEl.textContent = f.name;
    });
  }
  wireDropzone('listDrop', 'listFile', 'listFileName', '#newListForm [name="content"]');
  wireDropzone('knowledgeDrop', 'knowledgeFile', 'knowledgeFileName', '#newKnowledgeForm [name="content"]');

  $('#newListBtn').addEventListener('click', function () { $('#newListForm').reset(); openModal('newList'); });
  $('#newKnowledgeBtn').addEventListener('click', function () { $('#newKnowledgeForm').reset(); openModal('newKnowledge'); });

  $('#newListSave').addEventListener('click', function () {
    var fd = new FormData($('#newListForm'));
    var body = { name: fd.get('name') || undefined, criteria: fd.get('criteria') || undefined, content: fd.get('content') };
    if (!body.content) { toast('List data is required', 'error'); return; }
    api('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('newList'); toast('List created', 'success'); loadLists(); })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  $('#newKnowledgeSave').addEventListener('click', function () {
    var fd = new FormData($('#newKnowledgeForm'));
    var body = { name: fd.get('name') || undefined, content: fd.get('content') };
    if (!body.content) { toast('Content is required', 'error'); return; }
    api('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { closeModal('newKnowledge'); toast('Document added', 'success'); loadKnowledge(); })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  $('#listsList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.action === 'segment') segmentList(id);
    else if (btn.dataset.action === 'sendInvite') goToInvite(id);
    else if (btn.dataset.action === 'viewResult') viewListResult(id);
    else if (btn.dataset.action === 'deleteList') {
      confirmDialog('Delete list?', 'This list and its segmentation result will be removed.', 'Delete').then(function (ok) {
        if (!ok) return;
        api('/api/lists/' + id, { method: 'DELETE' }).then(function () { toast('List deleted', 'success'); loadLists(); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  $('#knowledgeList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'deleteKnowledge') {
      confirmDialog('Delete document?', 'This document will be removed from the knowledge base.', 'Delete').then(function (ok) {
        if (!ok) return;
        api('/api/knowledge/' + btn.dataset.id, { method: 'DELETE' }).then(function () { toast('Document deleted', 'success'); loadKnowledge(); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  $('#listResultBody').addEventListener('click', function (e) {
    var head = e.target.closest('.seg__head');
    if (!head) return;
    var seg = head.closest('.seg');
    if (seg) seg.dataset.open = seg.dataset.open === 'true' ? 'false' : 'true';
  });

  /* ---- AI settings ---- */
  var AI_DEFAULTS = null;

  function aiCard() {
    return '<div class="card"><h3 class="card__title">AI provider</h3>' +
      '<label class="field"><span class="field__label">Provider</span><select id="aiProvider">' +
        '<option value="openai">OpenAI</option>' +
        '<option value="claude">Claude (Anthropic)</option>' +
        '<option value="gemini">Gemini (Google)</option>' +
        '<option value="deepseek">DeepSeek</option>' +
        '<option value="custom">Custom (OpenAI-compatible)</option>' +
      '</select></label>' +
      '<label class="field"><span class="field__label">API key</span><input id="aiKey" type="password" placeholder="Leave blank to keep current" /></label>' +
      '<label class="field"><span class="field__label">Model</span><input id="aiModel" /></label>' +
      '<label class="field"><span class="field__label">Base URL</span><input id="aiBaseUrl" /></label>' +
      '<div class="conn__actions"><button class="btn btn--primary btn--sm" id="aiSave">Save</button> <button class="btn btn--ghost btn--sm" id="aiTest">Test</button></div>' +
      '<p class="muted" id="aiStatus"></p></div>';
  }

  function wireAi() {
    $('#aiProvider').addEventListener('change', function () {
      var d = (AI_DEFAULTS && AI_DEFAULTS[this.value]) || {};
      $('#aiModel').value = d.model || '';
      $('#aiModel').placeholder = d.model || '';
      $('#aiBaseUrl').value = d.baseUrl || '';
      $('#aiBaseUrl').placeholder = d.baseUrl || '';
    });
    $('#aiSave').addEventListener('click', saveAi);
    $('#aiTest').addEventListener('click', testAi);
  }

  function loadAiSettings() {
    return api('/api/ai/settings').then(function (d) {
      AI_DEFAULTS = d.defaults || {};
      if (d.configured) {
        $('#aiProvider').value = d.provider;
        $('#aiModel').value = d.model || '';
        $('#aiBaseUrl').value = d.baseUrl || '';
        $('#aiKey').placeholder = 'Current: ' + d.apiKeyMasked + ' (leave blank to keep)';
        $('#aiStatus').textContent = 'Configured (' + d.apiKeyMasked + ')';
      } else {
        $('#aiStatus').textContent = 'Not configured yet.';
      }
    }).catch(function () { $('#aiStatus').textContent = 'Could not load AI settings.'; });
  }

  function saveAi() {
    var provider = $('#aiProvider').value;
    var d = (AI_DEFAULTS && AI_DEFAULTS[provider]) || {};
    var body = {
      provider: provider,
      apiKey: $('#aiKey').value || undefined,
      model: $('#aiModel').value || d.model || undefined,
      baseUrl: $('#aiBaseUrl').value || d.baseUrl || undefined
    };
    withBusy($('#aiSave'), api('/api/ai/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(function (r) { $('#aiKey').value = ''; $('#aiStatus').textContent = 'Saved (' + (r.apiKeyMasked || '') + ')'; toast('AI settings saved', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function testAi() {
    $('#aiStatus').textContent = 'Testing…';
    withBusy($('#aiTest'), api('/api/ai/test', { method: 'POST' }))
      .then(function (d) { $('#aiStatus').textContent = 'Test OK — ' + d.reply; toast('AI test OK', 'success'); })
      .catch(function (e) { $('#aiStatus').textContent = 'Test failed — ' + e.message; toast(e.message, 'error'); });
  }

  /* ---- Modal helpers ---- */
  var openStack = [];
  var lastFocus = null;

  function openModal(id) {
    var el = $('#' + id);
    if (!el) return;
    lastFocus = document.activeElement;
    el.hidden = false;
    requestAnimationFrame(function () {
      el.classList.add('is-open');
      var f = el.querySelector('button, [href], input, select, textarea');
      if (f) f.focus();
    });
    openStack.push(id);
    document.body.classList.add('no-scroll');
  }

  function closeModal(id) {
    var el = $('#' + id);
    if (!el) return;
    el.classList.remove('is-open');
    setTimeout(function () { el.hidden = true; }, 160);
    openStack = openStack.filter(function (x) { return x !== id; });
    if (!openStack.length) document.body.classList.remove('no-scroll');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openStack.length) { closeModal(openStack[openStack.length - 1]); return; }
    if (e.key === 'Tab' && openStack.length) {
      var el = $('#' + openStack[openStack.length - 1]);
      var f = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      var first = f[0];
      var last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });

  $$('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { closeModal(b.dataset.close); });
  });
  $$('.backdrop').forEach(function (m) {
    m.addEventListener('click', function (e) {
      if (e.target === m) closeModal(m.id);
    });
  });

  function closeAllMenus() {
    $$('.menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
  }
  function toggleMenu(btn) {
    var wrap = btn.closest('.menu-wrap');
    var menu = wrap && wrap.querySelector('.menu');
    if (!menu) return;
    var willOpen = !menu.classList.contains('is-open');
    closeAllMenus();
    if (willOpen) menu.classList.add('is-open');
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.menu-wrap')) closeAllMenus();
  });

  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var old = $('#confirmBackdrop');
      if (old) old.remove();
      var bd = document.createElement('div');
      bd.className = 'backdrop';
      bd.id = 'confirmBackdrop';
      bd.innerHTML =
        '<div class="modal modal--sm" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">' +
          '<div class="modal__head"><h2 class="modal__title" id="confirmTitle"></h2><button class="icon-btn" id="confirmX" aria-label="Close">&times;</button></div>' +
          '<p class="confirm__msg"></p>' +
          '<div class="modal__foot"><span class="spacer"></span>' +
            '<button class="btn btn--ghost" id="confirmCancel">Cancel</button>' +
            '<button class="btn btn--danger" id="confirmOk"></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      bd.querySelector('#confirmTitle').textContent = title;
      bd.querySelector('.confirm__msg').textContent = message;
      bd.querySelector('#confirmOk').textContent = okLabel || 'Delete';
      var done = function (val) {
        closeModal('confirmBackdrop');
        setTimeout(function () { bd.remove(); }, 180);
        resolve(val);
      };
      bd.addEventListener('click', function (e) { if (e.target === bd) done(false); });
      bd.querySelector('#confirmOk').addEventListener('click', function () { done(true); });
      bd.querySelector('#confirmCancel').addEventListener('click', function () { done(false); });
      bd.querySelector('#confirmX').addEventListener('click', function () { done(false); });
      openModal('confirmBackdrop');
    });
  }

  /* ---- Auth & Team ---- */
  var authState = { enabled: false, authenticated: false, user: null };
  var authMode = 'login';
  var inviteToken = null;
  var teamData = null;

  function isAdmin() {
    return !!(authState.user && (authState.user.role === 'owner' || authState.user.role === 'admin'));
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    var a = (parts[0] || '?')[0] || '?';
    var b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
    return (a + b).toUpperCase();
  }

  function bootstrapAuth() {
    inviteToken = new URLSearchParams(window.location.search).get('token');
    return api('/api/auth/me')
      .then(function (d) {
        authState = d;
        if (d.needsSetup) return showAuthGate('setup');
        if (inviteToken) return showAuthGate('invite');
        if (d.enabled && !d.authenticated) return showAuthGate('login');
        startPanel();
      })
      .catch(function () {
        // /api/auth/me unreachable → assume auth is off and open the panel.
        startPanel();
      });
  }

  function startPanel() {
    document.getElementById('authGate').hidden = true;
    var wrap = document.getElementById('accountWrap');
    wrap.hidden = !authState.user;
    if (authState.user) {
      document.getElementById('accountName').textContent = (authState.user.name || authState.user.email) + ' · ' + authState.user.role;
      document.getElementById('accountBtn').textContent = initials(authState.user.name || authState.user.email);
    }
    var privileged = isAdmin() || !authState.enabled;
    $$('.topnav__link[data-role="admin"]').forEach(function (b) { b.hidden = !privileged; });
    loadCatalog();
    load();
    showView('campaigns');
  }

  function showAuthGate(mode) {
    authMode = mode;
    document.getElementById('authGate').hidden = false;
    document.getElementById('authError').hidden = true;
    var form = document.getElementById('authForm');
    form.reset();
    document.getElementById('authEmailWrap').hidden = mode === 'invite';
    document.getElementById('authNameWrap').hidden = mode === 'login';

    var titles = { login: 'Sign in', setup: 'Create your owner account', invite: 'Accept your invite' };
    var subs = {
      login: 'Welcome back.',
      setup: 'First-run setup — this disappears once an account exists.',
      invite: 'Set a password to join the team.'
    };
    document.getElementById('authTitle').textContent = titles[mode];
    document.getElementById('authSub').textContent = subs[mode];
    document.getElementById('authSubmit').textContent = mode === 'login' ? 'Sign in' : mode === 'setup' ? 'Create account' : 'Join team';
    form.querySelector('[name="password"]').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  }

  function submitAuth() {
    var fd = new FormData(document.getElementById('authForm'));
    var errEl = document.getElementById('authError');
    errEl.hidden = true;

    var path = authMode === 'login' ? '/api/auth/login' : authMode === 'setup' ? '/api/auth/setup' : '/api/auth/accept-invite';
    var body = { email: fd.get('email'), name: fd.get('name'), password: fd.get('password') };
    if (authMode === 'invite') body.token = inviteToken;

    withBusy(document.getElementById('authSubmit'), api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(function (r) {
        authState = { enabled: true, authenticated: true, user: r.user, needsSetup: false };
        if (inviteToken) {
          history.replaceState(null, '', '/');
          inviteToken = null;
        }
        toast('Welcome, ' + (r.user.name || r.user.email), 'success');
        startPanel();
      })
      .catch(function (e) {
        errEl.textContent = e.message;
        errEl.hidden = false;
      });
  }

  function roleChip(role) {
    var tone = role === 'owner' ? 'chip--warning' : role === 'admin' ? 'chip--success' : 'chip--neutral';
    return '<span class="chip ' + tone + '">' + esc(role) + '</span>';
  }

  function loadTeam() {
    document.getElementById('teamMembers').innerHTML = skeletonCards(3);
    return api('/api/team')
      .then(function (d) {
        teamData = d;
        renderTeamMembers(d.users || []);
        renderTeamInvites(d.invites || []);
        renderTeamAudit(d.audit || []);
        document.getElementById('teamWebhookUrl').value = (d.settings && d.settings.inviteWebhookUrl) || '';
      })
      .catch(function (e) {
        document.getElementById('teamMembers').innerHTML = '<div class="card"><p class="muted">' + esc(e.message) + '</p></div>';
      });
  }

  function renderTeamMembers(users) {
    var el = document.getElementById('teamMembers');
    el.innerHTML = '';
    users.forEach(function (u) {
      var me = authState.user && authState.user.id === u.id;
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(u.name) + (me ? ' <span class="muted" style="font-size:0.8rem">(you)</span>' : '') + '</span>' +
            roleChip(u.role) + (u.status === 'disabled' ? '<span class="chip chip--danger">disabled</span>' : '') + '</div>' +
          '<div class="conn__meta"><span>' + esc(u.email) + '</span>' +
            badge('Last login: ' + (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never')) + '</div>' +
        '</div>' +
        '<div class="conn__actions">' +
          '<select data-role-for="' + esc(u.id) + '" aria-label="Role">' +
            ['member', 'admin', 'owner'].map(function (r) {
              return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + r + '</option>';
            }).join('') +
          '</select>' +
          '<button class="btn btn--ghost btn--sm" data-action="toggleUser" data-id="' + esc(u.id) + '" data-status="' +
            (u.status === 'disabled' ? 'active' : 'disabled') + '">' + (u.status === 'disabled' ? 'Enable' : 'Disable') + '</button>' +
          '<button class="btn btn--danger btn--sm" data-action="removeUser" data-id="' + esc(u.id) + '">Remove</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function renderTeamInvites(invites) {
    var el = document.getElementById('teamInvites');
    if (!invites.length) {
      el.innerHTML = '<p class="muted">No pending invites.</p>';
      return;
    }
    el.innerHTML = '';
    invites.forEach(function (i) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(i.email) + '</span>' + roleChip(i.role) + '</div>' +
          '<div class="conn__meta"><span>Invited by ' + esc(i.invitedBy) + '</span>' +
            badge('Expires ' + new Date(i.expiresAt).toLocaleDateString()) + '</div>' +
          '<div class="invite-link"><input readonly value="' + esc(i.inviteUrl) + '" aria-label="Invite link" />' +
            '<button class="btn btn--ghost btn--sm" data-action="copyInvite" data-url="' + esc(i.inviteUrl) + '">Copy</button></div>' +
        '</div>' +
        '<div class="conn__actions">' +
          '<button class="btn btn--ghost btn--sm" data-action="resendInvite" data-id="' + esc(i.id) + '">Resend</button>' +
          '<button class="btn btn--danger btn--sm" data-action="revokeInvite" data-id="' + esc(i.id) + '">Revoke</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function renderTeamAudit(events) {
    var el = document.getElementById('teamAudit');
    if (!events.length) {
      el.innerHTML = '<p class="muted">No activity yet.</p>';
      return;
    }
    el.innerHTML = '<table class="map" aria-label="Activity"><thead><tr><th>When</th><th>What</th><th>Who</th><th>Detail</th></tr></thead><tbody>' +
      events.map(function (e) {
        return '<tr><td title="' + esc(new Date(e.at).toLocaleString()) + '">' + relativeTime(e.at) + '</td>' +
          '<td>' + esc(e.action) + '</td><td>' + esc(e.actor || '—') + '</td><td>' + esc(e.detail || '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { toast('Link copied', 'success'); })
        .catch(function () { toast('Copy failed — select and copy manually', 'error'); });
    } else {
      toast('Copy not supported — select and copy manually', 'error');
    }
  }

  function openInviteMember() {
    document.getElementById('inviteMemberForm').reset();
    var r = document.getElementById('inviteMemberResult');
    r.hidden = true;
    r.innerHTML = '';
    openModal('inviteMember');
  }

  function submitInvite() {
    var fd = new FormData(document.getElementById('inviteMemberForm'));
    var body = { email: fd.get('email'), name: fd.get('name') || undefined, role: fd.get('role') };
    if (!body.email) { toast('Email is required', 'error'); return; }

    withBusy(document.getElementById('inviteMemberSave'), api('/api/team/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(function (r) {
        var ok = r.webhook && r.webhook.ok;
        var note = ok ? 'Webhook sent.' : 'Webhook: ' + ((r.webhook && r.webhook.detail) || 'not configured');
        var box = document.getElementById('inviteMemberResult');
        box.hidden = false;
        box.className = 'invite-result ' + (ok ? 'invite-result--success' : 'invite-result--error');
        box.innerHTML = '<div>Invite created for <strong>' + esc(r.invite.email) + '</strong> (' + esc(r.invite.role) + '). ' + esc(note) + '</div>' +
          '<div class="invite-link"><input readonly value="' + esc(r.inviteUrl) + '" aria-label="Invite link" />' +
          '<button class="btn btn--ghost btn--sm" data-action="copyInvite" data-url="' + esc(r.inviteUrl) + '">Copy</button></div>';
        toast('Invite created', 'success');
        loadTeam();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  document.getElementById('newMemberBtn').addEventListener('click', openInviteMember);
  document.getElementById('inviteMemberSave').addEventListener('click', submitInvite);

  document.getElementById('inviteMemberResult').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="copyInvite"]');
    if (btn) copyText(btn.dataset.url);
  });

  document.getElementById('teamMembers').addEventListener('change', function (e) {
    var sel = e.target.closest('[data-role-for]');
    if (!sel) return;
    api('/api/team/users/' + sel.dataset.roleFor, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value }) })
      .then(function () { toast('Role updated', 'success'); loadTeam(); })
      .catch(function (err) { toast(err.message, 'error'); loadTeam(); });
  });

  document.getElementById('teamMembers').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.action === 'toggleUser') {
      api('/api/team/users/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: btn.dataset.status }) })
        .then(function () { toast('Updated', 'success'); loadTeam(); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'removeUser') {
      confirmDialog('Remove member?', 'They lose access immediately.', 'Remove').then(function (ok) {
        if (!ok) return;
        api('/api/team/users/' + id, { method: 'DELETE' })
          .then(function () { toast('Member removed', 'success'); loadTeam(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  document.getElementById('teamInvites').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'copyInvite') { copyText(btn.dataset.url); return; }
    if (btn.dataset.action === 'resendInvite') {
      withBusy(btn, api('/api/team/invites/' + btn.dataset.id + '/resend', { method: 'POST' }))
        .then(function (r) {
          toast(r.webhook && r.webhook.ok ? 'Invite re-sent' : 'Link ready (webhook: ' + ((r.webhook && r.webhook.detail) || 'not configured') + ')', 'success');
          loadTeam();
        })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'revokeInvite') {
      confirmDialog('Revoke invite?', 'The invite link will stop working.', 'Revoke').then(function (ok) {
        if (!ok) return;
        api('/api/team/invites/' + btn.dataset.id, { method: 'DELETE' })
          .then(function () { toast('Invite revoked', 'success'); loadTeam(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    }
  });

  document.getElementById('teamWebhookSave').addEventListener('click', function () {
    var url = document.getElementById('teamWebhookUrl').value.trim();
    withBusy(this, api('/api/team/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteWebhookUrl: url }) }))
      .then(function () { toast('Invite delivery saved', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('teamWebhookTest').addEventListener('click', function () {
    withBusy(this, api('/api/team/settings/test', { method: 'POST' }))
      .then(function (r) {
        document.getElementById('teamWebhookStatus').textContent = r.ok ? 'Test delivered.' : 'Test failed — ' + (r.detail || 'unknown');
        toast(r.ok ? 'Webhook test OK' : 'Webhook test failed', r.ok ? 'success' : 'error');
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('accountBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleMenu(this);
  });

  document.querySelector('#accountWrap .menu').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    closeAllMenus();
    if (btn.dataset.action === 'logout') {
      api('/api/auth/logout', { method: 'POST' })
        .then(function () {
          authState = { enabled: true, authenticated: false, user: null };
          showAuthGate('login');
        })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'changePassword') {
      document.getElementById('changePasswordForm').reset();
      openModal('changePassword');
    }
  });

  document.getElementById('changePasswordSave').addEventListener('click', function () {
    var fd = new FormData(document.getElementById('changePasswordForm'));
    var body = { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword') };
    withBusy(this, api('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(function () {
        closeModal('changePassword');
        toast('Password updated — please sign in again', 'success');
        authState = { enabled: true, authenticated: false, user: null };
        showAuthGate('login');
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  document.getElementById('authSubmit').addEventListener('click', submitAuth);
  document.getElementById('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    submitAuth();
  });

  /* ---- Senders ---- */
  var senderData = [];

  function daysCheckboxes(selected) {
    var days = [['0', 'S'], ['1', 'M'], ['2', 'T'], ['3', 'W'], ['4', 'T'], ['5', 'F'], ['6', 'S']];
    return days
      .map(function (d) {
        return '<label class="daychk"><input type="checkbox" data-day="' + d[0] + '"' +
          (selected.indexOf(Number(d[0])) !== -1 ? ' checked' : '') + ' /><span>' + d[1] + '</span></label>';
      })
      .join('');
  }

  function loadSenders() {
    document.getElementById('sendersList').innerHTML = skeletonCards(2);
    return api('/api/senders')
      .then(function (d) {
        senderData = d.senders || [];
        renderSenders(senderData);
      })
      .catch(function (e) {
        document.getElementById('sendersList').innerHTML = '<div class="card"><p class="muted">' + esc(e.message) + '</p></div>';
      });
  }

  function renderSenders(senders) {
    var el = document.getElementById('sendersList');
    el.innerHTML = '';
    if (!senders.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('send') + '</div><h2 class="empty__title">No sending accounts yet</h2><p class="empty__text">Link a Google account and it will show up here so you can set its limits.</p></div>';
      return;
    }

    senders.forEach(function (s) {
      var p = s.profile;
      var t = s.today;

      var chips = p.enabled ? '<span class="chip chip--success">sending</span>' : '<span class="chip chip--neutral">paused</span>';
      if (t.cooling) chips += '<span class="chip chip--danger">resting</span>';
      if (p.enabled && !t.inWindow) chips += '<span class="chip chip--warning">outside sending hours</span>';
      if (p.mode === 'ramp' && t.rampDayIndex) chips += '<span class="chip chip--neutral">warm-up day ' + t.rampDayIndex + '</span>';

      var pct = t.capToday > 0 ? Math.min(100, Math.round((t.sentToday / t.capToday) * 100)) : 0;
      var hourly = p.hourlyCap ? ' / ' + p.hourlyCap : '';

      var box = document.createElement('div');
      box.className = 'conn sender';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(s.name) + '</span>' + chips + '</div>' +
          '<div class="conn__meta"><span class="conn__cal">' + icon('send') + esc(s.calendarId) + '</span></div>' +
          '<div class="gauge"><div class="gauge__bar"><span style="width:' + pct + '%"></span></div>' +
            '<div class="gauge__label">Sent today <strong>' + t.sentToday + '</strong> of ' + t.capToday +
              ' · ' + t.headroom + ' still available · ' + t.sentThisHour + ' this hour' + hourly +
              (t.failedToday ? ' · ' + t.failedToday + " didn't go through" : '') + '</div></div>' +
          '<div class="sender__grid">' +
            '<label class="field"><span class="field__label">How it sends</span><select data-f="mode">' +
              '<option value="flat"' + (p.mode === 'flat' ? ' selected' : '') + '>Steady</option>' +
              '<option value="ramp"' + (p.mode === 'ramp' ? ' selected' : '') + '>Warm up slowly</option></select></label>' +
            '<label class="field"><span class="field__label">Max per day</span><input type="number" min="1" max="5000" data-f="dailyCap" value="' + p.dailyCap + '" /></label>' +
            '<label class="field"><span class="field__label">Max per hour</span><input type="number" min="1" max="1000" data-f="hourlyCap" value="' + (p.hourlyCap || '') + '" /></label>' +
            '<label class="field"><span class="field__label">Pause between batches (ms)</span><input type="number" min="0" max="600000" data-f="minDelayMs" value="' + (p.minDelayMs === undefined ? '' : p.minDelayMs) + '" /></label>' +
          '</div>' +
          '<div class="sender__ramp"' + (p.mode === 'ramp' ? '' : ' hidden') + '>' +
            '<div class="sender__grid">' +
              '<label class="field"><span class="field__label">Start with (per day)</span><input type="number" min="1" max="5000" data-f="rampStart" value="' + (p.ramp ? p.ramp.startDailyCap : 50) + '" /></label>' +
              '<label class="field"><span class="field__label">Add each day</span><input type="number" min="0" max="5000" data-f="rampInc" value="' + (p.ramp ? p.ramp.incrementPerDay : 50) + '" /></label>' +
              '<label class="field"><span class="field__label">Up to (per day)</span><input type="number" min="1" max="5000" data-f="rampMax" value="' + (p.ramp ? p.ramp.maxDailyCap : 800) + '" /></label>' +
              '<label class="field"><span class="field__label">Warm-up started on</span><input type="date" data-f="rampStartDate" value="' + (p.ramp ? p.ramp.startDate : new Date().toISOString().slice(0, 10)) + '" /></label>' +
            '</div>' +
          '</div>' +
          '<div class="sender__grid">' +
            '<label class="field"><span class="field__label">Send from (hour)</span><input type="number" min="0" max="23" data-f="winStart" value="' + p.window.startHour + '" /></label>' +
            '<label class="field"><span class="field__label">Send until (hour)</span><input type="number" min="0" max="23" data-f="winEnd" value="' + p.window.endHour + '" /></label>' +
            '<label class="field"><span class="field__label">Time zone</span><input data-f="winTz" list="tzList" value="' + esc(p.window.timeZone) + '" /></label>' +
            '<div class="field"><span class="field__label">Days</span><div class="daychks">' + daysCheckboxes(p.window.days || []) + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="conn__actions">' +
          '<button class="btn btn--ghost btn--sm" data-action="toggleSender" data-id="' + esc(s.connectionId) + '" data-enabled="' + (p.enabled ? '1' : '0') + '">' + (p.enabled ? 'Pause' : 'Resume') + '</button>' +
          '<button class="btn btn--outline btn--sm" data-action="sendNowSender" data-id="' + esc(s.connectionId) + '">Send now</button>' +
          '<button class="btn btn--primary btn--sm" data-action="saveSender" data-id="' + esc(s.connectionId) + '">Save</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function readSenderCard(card) {
    function num(sel, fallback) {
      var e = card.querySelector(sel);
      if (!e) return fallback;
      var raw = String(e.value).trim();
      if (raw === '') return fallback;
      var v = Number(raw);
      return Number.isFinite(v) ? v : fallback;
    }
    function str(sel, fallback) {
      var e = card.querySelector(sel);
      var v = e ? String(e.value).trim() : '';
      return v || fallback;
    }

    var days = $$('[data-day]', card)
      .filter(function (c) { return c.checked; })
      .map(function (c) { return Number(c.dataset.day); });

    var mode = str('[data-f="mode"]', 'flat');
    var body = {
      mode: mode,
      dailyCap: num('[data-f="dailyCap"]', 800),
      minDelayMs: num('[data-f="minDelayMs"]', undefined),
      window: {
        startHour: num('[data-f="winStart"]', 9),
        endHour: num('[data-f="winEnd"]', 17),
        days: days,
        timeZone: str('[data-f="winTz"]', 'UTC')
      }
    };

    var hourly = num('[data-f="hourlyCap"]', undefined);
    if (hourly !== undefined) body.hourlyCap = hourly;

    if (mode === 'ramp') {
      body.ramp = {
        startDailyCap: num('[data-f="rampStart"]', 50),
        incrementPerDay: num('[data-f="rampInc"]', 50),
        maxDailyCap: num('[data-f="rampMax"]', 800),
        startDate: str('[data-f="rampStartDate"]', new Date().toISOString().slice(0, 10))
      };
    }
    return body;
  }

  document.getElementById('sendersList').addEventListener('change', function (e) {
    var sel = e.target.closest('[data-f="mode"]');
    if (!sel) return;
    var card = sel.closest('.sender');
    var ramp = card && card.querySelector('.sender__ramp');
    if (ramp) ramp.hidden = sel.value !== 'ramp';
  });

  document.getElementById('sendersList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    var card = btn.closest('.sender');

    if (btn.dataset.action === 'saveSender' && card) {
      withBusy(btn, api('/api/senders/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readSenderCard(card)) }))
        .then(function () { toast('Saved', 'success'); loadSenders(); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'sendNowSender') {
      withBusy(btn, api('/api/senders/' + id + '/send-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxPerSender: 200 }) }))
        .then(function (r) {
          if (r.sent) {
            toast('Sent ' + r.sent + (r.failed ? '. ' + r.failed + " didn't go through" : '') +
              (r.reason ? ' — ' + reasonLabel(r.reason) : ''), 'success');
          } else {
            toast('Nothing sent — ' + (reasonLabel(r.reason) || 'nothing was waiting'), 'error');
          }
          loadSenders();
        })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'toggleSender') {
      var action = btn.dataset.enabled === '1' ? 'pause' : 'resume';
      withBusy(btn, api('/api/senders/' + id + '/' + action, { method: 'POST' }))
        .then(function () { toast(action === 'pause' ? 'That account is paused' : 'That account is sending again', 'success'); loadSenders(); })
        .catch(function (err) { toast(err.message, 'error'); });
    }
  });

  /* ---- Campaigns ---- */
  var campaignData = [];
  var campLists = [];
  var campSessions = [];
  var campConnections = [];
  var currentCampaignId = null;

  function campStatusChip(status) {
    var tone = { draft: 'neutral', active: 'success', paused: 'warning', completed: 'neutral' };
    var words = { draft: 'Not started', active: 'Sending', paused: 'Paused', completed: 'Finished' };
    return '<span class="chip chip--' + (tone[status] || 'neutral') + '">' + esc(words[status] || status) + '</span>';
  }

  function spreadLabel(mode) {
    return mode === 'weighted' ? 'using your shares' : 'split evenly';
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function prettyDate(value) {
    var t = Date.parse(String(value || ''));
    if (!t) return String(value || '');
    var d = new Date(t);
    var out = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getHours() || d.getMinutes()) out += ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return out;
  }

  /* Plain words for the short status codes the server sends back. */
  var REASON_LABELS = {
    'paused': 'this account is paused',
    'cooling down': 'this account is resting',
    'outside send window': 'outside sending hours',
    'daily cap reached': 'already at the daily limit',
    'hourly cap reached': 'already at the limit for this hour',
    'inter-batch delay': 'waiting for the pause between batches',
    'nothing queued': 'nothing waiting to send',
    'connection missing': 'that Google account is no longer linked'
  };

  function reasonLabel(reason) {
    if (!reason) return '';
    return REASON_LABELS[reason] || reason;
  }

  function connName(id) {
    var c = (state.connections || []).filter(function (x) { return x.id === id; })[0];
    return c ? c.name : String(id).slice(0, 8);
  }

  function campListName(id) {
    var l = (campLists || []).filter(function (x) { return x.id === id; })[0];
    return l ? l.name : 'unknown list';
  }

  function loadCampaigns() {
    document.getElementById('campaignsList').innerHTML = skeletonCards(2);
    return Promise.all([api('/api/campaigns'), api('/api/lists'), api('/api/sessions'), api('/api/connections')])
      .then(function (r) {
        campaignData = r[0].campaigns || [];
        campLists = r[1].lists || [];
        campSessions = r[2].sessions || [];
        campConnections = r[3].connections || [];
        renderCampaigns(campaignData);
      })
      .catch(function (e) {
        document.getElementById('campaignsList').innerHTML = '<div class="card"><p class="muted">' + esc(e.message) + '</p></div>';
      });
  }

  function campaignActions(c) {
    var out = '';
    if (c.status === 'draft') {
      out += '<button class="btn btn--primary btn--sm" data-action="campStart" data-id="' + esc(c.id) + '">Begin sending</button>';
    } else if (c.status === 'active') {
      out += '<button class="btn btn--outline btn--sm" data-action="campSend" data-id="' + esc(c.id) + '">Send the next batch</button>';
      out += '<button class="btn btn--ghost btn--sm" data-action="campPause" data-id="' + esc(c.id) + '">Pause</button>';
    } else if (c.status === 'paused') {
      out += '<button class="btn btn--outline btn--sm" data-action="campSend" data-id="' + esc(c.id) + '">Send the next batch</button>';
      out += '<button class="btn btn--ghost btn--sm" data-action="campResume" data-id="' + esc(c.id) + '">Resume</button>';
    }
    out += '<button class="btn btn--ghost btn--sm" data-action="campDetail" data-id="' + esc(c.id) + '">Details</button>';
    out += '<button class="btn btn--ghost btn--sm" data-action="campDelete" data-id="' + esc(c.id) + '">Delete</button>';
    return out;
  }

  /**
   * What stops a campaign existing at all, in the order the operator has to fix it. The
   * campaigns tab is the landing view, so this is often the first thing a new install sees —
   * it has to name what is missing and offer a way to go and fix it.
   */
  function campaignPrereq() {
    var conns = campConnections.length ? campConnections : (state.connections || []);
    var usable = conns.filter(function (c) { return c.status === 'active'; });
    if (!usable.length) {
      return { title: 'No Google accounts linked yet', text: 'A campaign sends from your own Google accounts. Link one first, then come back and create the campaign.', cta: 'Go to Google accounts', view: 'connections' };
    }
    var ready = campLists.filter(function (l) { return l.hasResult; });
    if (!ready.length) {
      return { title: 'No contact lists ready yet', text: 'Upload your contacts and let the AI sort them into groups. A campaign picks its audience from a sorted list.', cta: 'Go to Contact lists', view: 'lists' };
    }
    return null;
  }

  function renderCampaigns(camps) {
    var el = document.getElementById('campaignsList');
    el.innerHTML = '';

    var blocker = campaignPrereq();
    if (blocker) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('alert') + '</div>' +
        '<h2 class="empty__title">' + esc(blocker.title) + '</h2>' +
        '<p class="empty__text">' + esc(blocker.text) + '</p>' +
        '<button class="btn btn--accent" id="campaignPrereqCta">' + esc(blocker.cta) + '</button></div>';
      document.getElementById('campaignPrereqCta').onclick = function () { showView(blocker.view); };
      return;
    }

    if (!camps.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('calendar') + '</div><h2 class="empty__title">No campaigns yet</h2><p class="empty__text">Create one to share a contact list across several Google accounts at a safe pace.</p></div>';
      return;
    }

    camps.forEach(function (c) {
      var counts = c.counts || { total: 0, sent: 0, pending: 0, failed: 0 };
      var done = counts.total ? Math.round((counts.sent / counts.total) * 100) : 0;
      var mailboxes = (c.senders || []).filter(function (s) { return s.enabled; }).length;

      var box = document.createElement('div');
      box.className = 'conn campaign';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(c.name) + '</span>' + campStatusChip(c.status) +
            '<span class="chip chip--neutral">' + esc(spreadLabel(c.distribution.mode)) + '</span>' +
            (counts.failed ? '<span class="chip chip--danger">' + counts.failed + " didn't go through</span>" : '') + '</div>' +
          '<div class="conn__meta"><span class="conn__cal">' + icon('calendar') + esc(campListName(c.listId)) + '</span>' +
            '<span class="conn__cal">' + esc(prettyDate(c.event.start)) + '</span></div>' +
          '<div class="gauge"><div class="gauge__bar"><span style="width:' + done + '%"></span></div>' +
            '<div class="gauge__label">Sent <strong>' + counts.sent + '</strong> of ' + counts.total +
              ' · ' + counts.pending + ' still waiting · ' + mailboxes + ' ' + (mailboxes === 1 ? 'account' : 'accounts') + '</div></div>' +
        '</div>' +
        '<div class="conn__actions">' + campaignActions(c) + '</div>';
      el.appendChild(box);
    });
  }

  function campLocalInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function renderCampSenderRows() {
    var el = document.getElementById('campSenders');
    var conns = campConnections.length ? campConnections : (state.connections || []);
    if (!conns.length) {
      el.innerHTML = '<p class="muted">No Google accounts linked yet — link one first.</p>';
      return;
    }
    el.innerHTML = conns.map(function (c) {
      return '<div class="camp-sender" data-conn="' + esc(c.id) + '">' +
        '<label class="daychk"><input type="checkbox" data-pick checked /><span>' + esc(c.name) + '</span></label>' +
        '<input type="number" min="0" step="1" value="1" data-share placeholder="share" title="Share weight (used when spread is weighted)" aria-label="Share weight" />' +
        '<input type="number" min="0" step="1" data-quota placeholder="max" title="Optional maximum from this account" aria-label="Maximum from this account" />' +
      '</div>';
    }).join('');
  }

  function loadCampaignSegments() {
    var id = document.getElementById('campList').value;
    var el = document.getElementById('campSegments');
    if (!id) {
      el.innerHTML = '<span class="muted">no list selected</span>';
      return;
    }
    el.innerHTML = '<span class="muted">loading…</span>';
    api('/api/lists/' + id)
      .then(function (d) {
        var segs = (d.list && d.list.result && d.list.result.segments) || [];
        el.innerHTML = segs.length
          ? segs.map(function (s) {
              var n = (s.rows || []).length;
              return '<label class="daychk"><input type="checkbox" data-seg="' + esc(s.name) + '" /><span>' + esc(s.name) + ' (' + n + ')</span></label>';
            }).join('')
          : '<span class="muted">This list has no segments yet — run Segment first.</span>';
      })
      .catch(function () {
        el.innerHTML = '<span class="muted">Could not load segments.</span>';
      });
  }

  function openCampaignWizard() {
    document.getElementById('campList').innerHTML = campLists.length
      ? campLists.map(function (l) {
          return '<option value="' + esc(l.id) + '">' + esc(l.name) + (l.hasResult ? '' : ' — no segments yet') + '</option>';
        }).join('')
      : '<option value="">No lists yet</option>';

    document.getElementById('campSession').innerHTML = '<option value="">None</option>' +
      campSessions.map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.title || s.externalId) + '</option>';
      }).join('');

    document.getElementById('campName').value = '';
    document.getElementById('campSummary').value = '';
    document.getElementById('campDesc').value = '';
    document.getElementById('campMode').value = 'even';
    document.getElementById('campTz').value = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

    var start = new Date(Date.now() + 86400000);
    start.setHours(10, 0, 0, 0);
    document.getElementById('campStart').value = campLocalInput(start);
    document.getElementById('campEnd').value = campLocalInput(new Date(start.getTime() + 3600000));

    renderCampSenderRows();
    loadCampaignSegments();
    openModal('newCampaign');
  }

  function saveCampaign(btn) {
    var name = document.getElementById('campName').value.trim();
    var summary = document.getElementById('campSummary').value.trim();
    var listId = document.getElementById('campList').value;
    var start = document.getElementById('campStart').value;
    var end = document.getElementById('campEnd').value;

    if (!name) { toast('Give this campaign a name', 'error'); return; }
    if (!listId) { toast('Pick a contact list', 'error'); return; }
    if (!summary) { toast('Add a subject line', 'error'); return; }
    if (!start || !end) { toast('Add a start and end time', 'error'); return; }

    var senders = [];
    $$('.camp-sender', document.getElementById('campSenders')).forEach(function (row) {
      var pick = row.querySelector('[data-pick]');
      if (!pick || !pick.checked) return;
      var s = { connectionId: row.dataset.conn, enabled: true, priority: 5 };
      var share = Number(row.querySelector('[data-share]').value);
      var quota = Number(row.querySelector('[data-quota]').value);
      if (Number.isFinite(share) && share > 0) s.share = share;
      if (Number.isFinite(quota) && quota > 0) s.quota = Math.floor(quota);
      senders.push(s);
    });
    if (!senders.length) { toast('Pick at least one sending account', 'error'); return; }

    var segments = $$('[data-seg]', document.getElementById('campSegments'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return c.dataset.seg; });

    var body = {
      name: name,
      status: 'draft',
      listId: listId,
      segments: segments,
      sessionId: document.getElementById('campSession').value || undefined,
      event: {
        summary: summary,
        description: document.getElementById('campDesc').value.trim() || undefined,
        start: start,
        end: end,
        timeZone: document.getElementById('campTz').value.trim() || 'UTC'
      },
      senders: senders,
      distribution: { mode: document.getElementById('campMode').value }
    };

    withBusy(btn, api('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(function () {
        closeModal('newCampaign');
        toast('Campaign created', 'success');
        loadCampaigns();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function openCampaignDetail(id) {
    currentCampaignId = id;
    document.getElementById('campaignDetailBody').innerHTML = skeletonCards(1);
    openModal('campaignDetail');
    return Promise.all([
      api('/api/campaigns/' + id),
      api('/api/campaigns/' + id + '/plan'),
      api('/api/campaigns/' + id + '/stats').catch(function () { return null; })
    ])
      .then(function (r) { renderCampaignDetail(r[0].campaign, r[1], r[2] && r[2].stats); })
      .catch(function (e) {
        document.getElementById('campaignDetailBody').innerHTML = '<p class="muted">' + esc(e.message) + '</p>';
      });
  }

  function renderCampaignDetail(c, plan, stats) {
    document.getElementById('campaignDetailTitle').textContent = c.name;
    var counts = c.counts || { total: 0, sent: 0, pending: 0, failed: 0 };

    var planText = plan && plan.totalDays
      ? 'At this pace it will finish in about <strong>' + plan.totalDays + '</strong> ' + (plan.totalDays === 1 ? 'day' : 'days') +
        ' — around ' + plan.dailyCapacity + ' a day, done by ' + esc(prettyDate(plan.finishDate)) + '.'
      : 'Nothing can send right now — check the <strong>Sending accounts</strong> tab. An account may be paused, resting, or outside its sending hours.';

    var rows = (c.perSender || []).map(function (p) {
      return '<tr><td>' + esc(connName(p.connectionId)) + '</td><td>' + p.sent + '</td><td>' + p.queued +
        '</td><td>' + p.failed + '</td><td>' + (p.enabled ? 'yes' : 'no') + '</td></tr>';
    }).join('');

    document.getElementById('campaignDetailBody').innerHTML =
      '<div class="conn__head">' + campStatusChip(c.status) +
        '<span class="chip chip--neutral">' + esc(spreadLabel(c.distribution.mode)) + '</span>' +
        '<span class="chip chip--neutral">' + esc(campListName(c.listId)) + '</span></div>' +
      '<div class="summary">' +
        '<div class="summary__item"><span class="summary__value">' + counts.total + '</span><span class="summary__label">people</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + counts.sent + '</span><span class="summary__label">sent</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + counts.pending + '</span><span class="summary__label">still waiting</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + counts.failed + '</span><span class="summary__label">didn\'t go through</span></div>' +
      '</div>' +
      '<p class="muted">' + planText + '</p>' +
      '<h3 class="detail__sub">Progress by account</h3>' +
      '<table class="map"><thead><tr><th>Account</th><th>Sent</th><th>Waiting</th><th>Couldn\'t send</th><th>On</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="muted">Nothing sent yet.</td></tr>') + '</tbody></table>' +
      campaignStatsHtml(stats);
  }

  function campaignStatsHtml(stats) {
    if (!stats || !stats.funnel) return '';
    var f = stats.funnel;
    var withAtt = !!stats.hasAttendance;

    var html = '<h3 class="detail__sub">What happened</h3>' +
      '<div class="summary">' +
        '<div class="summary__item"><span class="summary__value">' + f.sent + '</span><span class="summary__label">invited (' + f.rsvpRate + '% replied)</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + f.accepted + '</span><span class="summary__label">said yes (' + f.acceptanceRate + '% of sent)</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + f.declined + '</span><span class="summary__label">said no</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + f.tentative + '</span><span class="summary__label">maybe</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + f.noResponse + '</span><span class="summary__label">no reply</span></div>' +
      '</div>';

    if (withAtt) {
      html += '<div class="summary">' +
        '<div class="summary__item"><span class="summary__value">' + f.attended + '</span><span class="summary__label">showed up (' + f.attendanceRate + '% of yes)</span></div>' +
        '<div class="summary__item"><span class="summary__value">' + f.noShow + '</span><span class="summary__label">didn\'t show</span></div>' +
      '</div>';
    } else {
      html += '<p class="muted">Who showed up appears once the linked video call has been synced in the <strong>Who attended</strong> tab.</p>';
    }

    var head = '<tr><th>Account</th><th>Sent</th><th>Yes</th><th>No</th><th>Maybe</th><th>No reply</th>' + (withAtt ? '<th>Showed up</th>' : '') + '</tr>';
    var body = (stats.perSender || []).map(function (x) {
      return '<tr><td>' + esc(connName(x.connectionId)) + '</td><td>' + x.sent + '</td><td>' + x.accepted +
        '</td><td>' + x.declined + '</td><td>' + x.tentative + '</td><td>' + x.noResponse + '</td>' +
        (withAtt ? '<td>' + x.attended + '</td>' : '') + '</tr>';
    }).join('');

    return html + '<h3 class="detail__sub">What happened, per sending account</h3>' +
      '<table class="map"><thead>' + head + '</thead><tbody>' +
      (body || '<tr><td colspan="' + (withAtt ? 7 : 6) + '" class="muted">Nothing sent yet.</td></tr>') + '</tbody></table>';
  }

  $('#campaignNew').addEventListener('click', openCampaignWizard);
  $('#campList').addEventListener('change', loadCampaignSegments);
  $('#campSave').addEventListener('click', function () { saveCampaign(this); });

  $('#campSendNow').addEventListener('click', function () {
    if (!currentCampaignId) return;
    var id = currentCampaignId;
    withBusy(this, api('/api/campaigns/' + id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxPerSender: 200 }) }))
      .then(function (r) {
        toast('Sent ' + r.sent + (r.failed ? '. ' + r.failed + " didn't go through" : ''), r.failed ? 'error' : 'success');
        openCampaignDetail(id);
        loadCampaigns();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  $('#campaignsList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;

    if (action === 'campDetail') { openCampaignDetail(id); return; }

    if (action === 'campDelete') {
      withBusy(btn, api('/api/campaigns/' + id, { method: 'DELETE' }))
        .then(function () { toast('Campaign deleted', 'success'); loadCampaigns(); })
        .catch(function (err) { toast(err.message, 'error'); });
      return;
    }

    var routes = {
      campStart: { path: 'start', msg: 'Started sending' },
      campSend: { path: 'send', msg: 'Batch sent' },
      campPause: { path: 'pause', msg: 'Paused' },
      campResume: { path: 'resume', msg: 'Sending again' }
    };
    var route = routes[action];
    if (!route) return;

    var opts = { method: 'POST' };
    if (action === 'campSend') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ maxPerSender: 200 });
    }

    withBusy(btn, api('/api/campaigns/' + id + '/' + route.path, opts))
      .then(function (r) {
        var extra = '';
        if (r && typeof r.sent === 'number') extra = ' — ' + r.sent + ' sent' + (r.failed ? '. ' + r.failed + " didn't go through" : '');
        else if (r && typeof r.recipients === 'number') extra = ' — ' + r.recipients + ' people added to the queue';
        toast(route.msg + extra, 'success');
        loadCampaigns();
      })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  /* ---- Advisor ---- */
  var advisorThread = [];

  function advisorSeverityChip(s) {
    var map = { critical: 'danger', warning: 'warning', info: 'neutral' };
    var words = { critical: 'important', warning: 'worth a look', info: 'for your info' };
    return '<span class="chip chip--' + (map[s] || 'neutral') + '">' + esc(words[s] || s) + '</span>';
  }

  function loadAdvisor() {
    document.getElementById('advisorBody').innerHTML = skeletonCards(2);
    return api('/api/advisor')
      .then(function (d) { renderAdvisor(d); })
      .catch(function (e) {
        document.getElementById('advisorBody').innerHTML = '<div class="card"><p class="muted">' + esc(e.message) + '</p></div>';
      });
  }

  function advisorRecCard(r) {
    return '<div class="card advisor">' +
      '<div class="conn__head"><span class="conn__name">' + esc(r.title) + '</span>' + advisorSeverityChip(r.severity) + '</div>' +
      '<p>' + esc(r.rationale) + '</p>' +
      (r.impact ? '<p class="muted">' + esc(r.impact) + '</p>' : '') +
      (r.actionLabel ? '<p class="muted">What this will change: <strong>' + esc(r.actionLabel) + '</strong></p>' : '') +
      '<div class="conn__actions">' +
        (r.action ? '<button class="btn btn--primary btn--sm" data-action="advisorApply" data-id="' + esc(r.id) + '">Do it</button>' : '') +
        '<button class="btn btn--ghost btn--sm" data-action="advisorDismiss" data-id="' + esc(r.id) + '">Ignore</button>' +
      '</div></div>';
  }

  function renderAdvisor(d) {
    var el = document.getElementById('advisorBody');
    var a = d && d.analysis;

    if (!a) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('spark') + '</div>' +
        '<h2 class="empty__title">Nothing checked yet</h2>' +
        '<p class="empty__text">Press Check my setup to look over your accounts and your results. Only totals are used — never contact details.</p></div>';
      return;
    }

    var recs = a.recommendations || [];
    var open = recs.filter(function (r) { return r.state === 'open'; });
    var resolved = recs.filter(function (r) { return r.state !== 'open'; });

    var html =
      '<div class="card">' +
        '<div class="conn__head"><span class="conn__name">What I found</span>' +
          (a.provider ? '<span class="chip chip--success">' + esc(a.provider) + ' · ' + esc(a.model || '') + '</span>' : '<span class="chip chip--neutral">built-in checks</span>') +
          '<span class="chip chip--neutral">' + esc(relativeTime(a.createdAt)) + '</span></div>' +
        '<p>' + esc(a.summary) + '</p>' +
        (a.note ? '<p class="muted">' + esc(a.note) + '</p>' : '') +
      '</div>';

    html += '<h3 class="detail__sub">Suggestions (' + open.length + ' open)</h3>';
    html += open.length
      ? open.map(advisorRecCard).join('')
      : '<div class="card"><p class="muted">Nothing needs changing right now.</p></div>';

    if (resolved.length) {
      html += '<h3 class="detail__sub">Done</h3><div class="card">' +
        resolved.map(function (r) {
          return '<div class="advisor__row"><span class="chip chip--' + (r.state === 'applied' ? 'success' : 'neutral') + '">' + (r.state === 'applied' ? 'done' : 'ignored') + '</span>' +
            '<span>' + esc(r.title) + '</span>' +
            (r.actionLabel ? '<span class="muted">' + esc(r.actionLabel) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
    }

    html += '<h3 class="detail__sub">Ask a question</h3>' +
      '<div class="card">' +
        '<div class="advisor__thread" id="advisorThread"></div>' +
        '<label class="field"><span class="field__label">Question</span>' +
          '<input id="advisorQuestion" placeholder="e.g. how long until campaign 1 finishes?" /></label>' +
        '<div class="conn__actions"><button class="btn btn--outline btn--sm" id="advisorAsk">Ask</button></div>' +
      '</div>';

    html += '<details class="card"><summary>What we sent the AI</summary>' +
      '<table class="map"><thead><tr><th>Item</th><th>Sent?</th><th>Note</th></tr></thead><tbody>' +
      (d.appendix || []).map(function (row) {
        return '<tr><td>' + esc(row.field) + '</td><td>' + (row.included ? 'yes' : '<strong>no</strong>') + '</td>' +
          '<td class="muted">' + esc(row.note) + '</td></tr>';
      }).join('') + '</tbody></table></details>';

    if ((d.log || []).length) {
      html += '<h3 class="detail__sub">Changes you\'ve applied</h3><div class="card">' +
        d.log.map(function (e) {
          return '<div class="advisor__row"><span class="chip chip--' + (e.ok ? 'success' : 'danger') + '">' + (e.ok ? 'done' : 'failed') + '</span>' +
            '<span>' + esc(e.description || e.title) + '</span>' +
            '<span class="muted">' + esc(relativeTime(e.at)) + (e.actor ? ' · ' + esc(e.actor) : '') + '</span></div>';
        }).join('') + '</div>';
    }

    el.innerHTML = html;
    paintAdvisorThread();
  }

  function paintAdvisorThread() {
    var el = document.getElementById('advisorThread');
    if (!el) return;
    el.innerHTML = advisorThread.map(function (m) {
      return '<div class="advisor__msg advisor__msg--' + m.role + '">' + esc(m.text) + '</div>';
    }).join('');
  }

  function appendAdvisorMessage(role, text) {
    advisorThread.push({ role: role, text: text });
    paintAdvisorThread();
  }

  function askAdvisorQuestion() {
    var input = document.getElementById('advisorQuestion');
    if (!input) return;
    var q = String(input.value || '').trim();
    if (!q) return;
    input.value = '';
    appendAdvisorMessage('you', q);

    var btn = document.getElementById('advisorAsk');
    withBusy(btn, api('/api/advisor/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) }))
      .then(function (r) { appendAdvisorMessage('advisor', r.answer || '(no answer returned)'); })
      .catch(function (err) { appendAdvisorMessage('advisor', 'Error: ' + err.message); });
  }

  $('#advisorAnalyze').addEventListener('click', function () {
    var btn = this;
    withBusy(btn, api('/api/advisor/analyze', { method: 'POST' }))
      .then(function () {
        advisorThread = [];
        toast('Done — here is what I found', 'success');
        return loadAdvisor();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  $('#advisorBody').addEventListener('click', function (e) {
    if (e.target.closest('#advisorAsk')) {
      askAdvisorQuestion();
      return;
    }

    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;

    if (btn.dataset.action === 'advisorApply') {
      withBusy(btn, api('/api/advisor/recommendations/' + id + '/apply', { method: 'POST' }))
        .then(function (r) {
          toast('Done: ' + (r.description || 'change saved'), 'success');
          loadAdvisor();
          loadCampaigns();
          loadSenders();
        })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (btn.dataset.action === 'advisorDismiss') {
      withBusy(btn, api('/api/advisor/recommendations/' + id + '/dismiss', { method: 'POST' }))
        .then(function () { toast('Dismissed', 'success'); loadAdvisor(); })
        .catch(function (err) { toast(err.message, 'error'); });
    }
  });

  /* ---- How it works (single source of truth for the tour too) ---- */
  var HELP_STEPS = [
    {
      title: 'Start here: a campaign',
      body: 'A campaign is one event, the people to invite, and the accounts that send it, all in one place. Everything else here feeds into it.'
    },
    {
      title: 'Link a Google account',
      body: 'Connect the Google account you want to send from. We keep an eye on its calendar, so every reply comes straight back to us.'
    },
    {
      title: 'Add your contacts',
      body: 'Upload a spreadsheet or paste a list of people, then tell the AI how to group them — for example hot, warm and cold.'
    },
    {
      title: 'Set what each account may send',
      body: 'Give each account a limit per day and per hour, choose which hours it may send, and warm a brand new account up slowly.'
    },
    {
      title: 'Send to a big list safely',
      body: 'A campaign shares one contact list across several accounts and spreads the sending over days, so it never looks like spam.'
    },
    {
      title: 'Watch who replies',
      body: 'Yes, No and Maybe come back on their own, and are copied into GoHighLevel with the status and tags you picked.'
    },
    {
      title: 'See who turned up',
      body: 'Link a video call and we match the people who joined against the people you invited, so you know who actually showed up.'
    },
    {
      title: 'Send a one-off invitation',
      body: 'For a single event you can skip the campaign and invite one contact list from one account straight away.'
    },
    {
      title: 'Teach the AI your words',
      body: 'Add notes and documents so anything the AI writes back sounds like you.'
    },
    {
      title: 'Ask the Assistant',
      body: 'The Assistant looks at your own numbers and suggests small changes. Nothing changes until you press Do it.'
    },
    {
      title: 'Bring your team in',
      body: 'Invite the people who need access and choose whether they are an owner, an admin, or a member.'
    }
  ];

  /* Each tour stop reuses the matching How-it-works text, so the two can never drift. */
  var TOUR_STEPS = [
    { help: 0, view: 'campaigns', target: '#campaignNew', placement: 'bottom' },
    { help: 1, view: 'connections', target: '#newConnectionBtn', placement: 'bottom' },
    { help: 2, view: 'lists', target: '#newListBtn', placement: 'bottom' },
    { help: 3, view: 'senders', target: '#sendersList', placement: 'bottom', adminOnly: true },
    { help: 4, view: 'campaigns', target: '[data-view="campaigns"]', placement: 'bottom' },
    { help: 5, view: 'invites', target: '[data-view="invites"]', placement: 'bottom' },
    { help: 6, view: 'attendance', target: '[data-view="attendance"]', placement: 'bottom' },
    { help: 7, view: 'invites', target: '#inviteSend', placement: 'top' },
    { help: 8, view: 'knowledge', target: '#newKnowledgeBtn', placement: 'bottom' },
    { help: 9, view: 'advisor', target: '#advisorAnalyze', placement: 'bottom', adminOnly: true },
    { help: 10, view: 'team', target: '#newMemberBtn', placement: 'bottom', adminOnly: true }
  ];

  function openHowItWorks() {
    closeAllMenus();
    document.getElementById('howItWorksBody').innerHTML = HELP_STEPS.map(function (s, i) {
      return '<div class="help-step"><span class="help-step__num">' + (i + 1) + '</span><div>' +
        '<div class="help-step__title">' + esc(s.title) + '</div>' +
        '<p class="help-step__body">' + esc(s.body) + '</p></div></div>';
    }).join('');
    openModal('howItWorks');
  }

  /* ---- Guided tour ---- */
  var TOUR_KEY = 'vs.tour.v1';
  var tourState = { index: 0, steps: [], open: false, view: null, handler: null };

  function tourAlreadySeen() {
    try { return localStorage.getItem(TOUR_KEY) === 'done'; } catch (e) { return true; }
  }

  function rememberTour() {
    try { localStorage.setItem(TOUR_KEY, 'done'); } catch (e) { /* private mode: just do not remember */ }
  }

  function tourPlace(rect, placement) {
    var pad = 6;
    var cut = document.getElementById('tourCut');
    var card = document.getElementById('tourCard');

    cut.style.left = (rect.left - pad) + 'px';
    cut.style.top = (rect.top - pad) + 'px';
    cut.style.width = (rect.width + pad * 2) + 'px';
    cut.style.height = (rect.height + pad * 2) + 'px';

    var cw = card.offsetWidth || 330;
    var ch = card.offsetHeight || 190;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var gap = 14;

    var top = placement === 'top' ? rect.top - ch - gap : rect.bottom + gap;
    if (top < 10) top = rect.bottom + gap;
    if (top + ch > vh - 10) top = Math.max(10, rect.top - ch - gap);

    card.style.top = top + 'px';
    card.style.left = Math.min(Math.max(10, rect.left + rect.width / 2 - cw / 2), vw - cw - 10) + 'px';
  }

  function tourPaint() {
    var step = tourState.steps[tourState.index];
    if (!step) { tourStop(); return; }

    var help = HELP_STEPS[step.help] || { title: '', body: '' };
    document.getElementById('tourCount').textContent = 'Step ' + (tourState.index + 1) + ' of ' + tourState.steps.length;
    document.getElementById('tourTitle').textContent = help.title;
    document.getElementById('tourBody').textContent = help.body;
    document.getElementById('tourPrev').disabled = tourState.index === 0;
    document.getElementById('tourNext').textContent = tourState.index === tourState.steps.length - 1 ? 'Done' : 'Next';

    var el = document.querySelector(step.target);
    var rect = el ? el.getBoundingClientRect() : null;

    // Nothing to point at — the tab is hidden for this role, or the panel is empty. Move on
    // quietly instead of floating a tooltip in the middle of nowhere.
    if (!rect || !rect.width || !rect.height) {
      if (tourState.index >= tourState.steps.length - 1) { tourStop(); return; }
      tourState.index += 1;
      tourAdvance();
      return;
    }

    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    tourPlace(el.getBoundingClientRect(), step.placement);
  }

  function tourAdvance() {
    var step = tourState.steps[tourState.index];
    if (!step) { tourStop(); return; }

    // Switch tabs before measuring, then measure on the next frame so layout has settled.
    if (step.view && tourState.view !== step.view) {
      tourState.view = step.view;
      showView(step.view);
    }
    requestAnimationFrame(function () {
      if (tourState.open) tourPaint();
    });
  }

  function tourGoto(index) {
    if (index < 0) return;
    if (index >= tourState.steps.length) { tourStop(); return; }
    tourState.index = index;
    tourAdvance();
  }

  function tourStart(force) {
    if (!force && tourAlreadySeen()) return;

    closeAllMenus();
    var privileged = isAdmin() || !authState.enabled;
    tourState.steps = TOUR_STEPS.filter(function (s) { return !s.adminOnly || privileged; });
    tourState.index = 0;
    tourState.view = null;
    tourState.open = true;

    document.getElementById('tourRoot').hidden = false;

    tourState.handler = function () { if (tourState.open) tourPaint(); };
    window.addEventListener('resize', tourState.handler);
    window.addEventListener('scroll', tourState.handler, true);

    tourAdvance();
  }

  function tourStop() {
    if (!tourState.open) return;
    tourState.open = false;
    document.getElementById('tourRoot').hidden = true;

    if (tourState.handler) {
      window.removeEventListener('resize', tourState.handler);
      window.removeEventListener('scroll', tourState.handler, true);
      tourState.handler = null;
    }
    rememberTour();
  }

  function refreshTourCta() {
    var cta = document.getElementById('emptyTourCta');
    if (cta) cta.hidden = tourAlreadySeen();
  }

  document.addEventListener('keydown', function (e) {
    if (!tourState.open) return;
    if (e.key === 'Escape') { tourStop(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); tourGoto(tourState.index + 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); tourGoto(tourState.index - 1); }
  });

  $('#tourNext').addEventListener('click', function () { tourGoto(tourState.index + 1); });
  $('#tourPrev').addEventListener('click', function () { tourGoto(tourState.index - 1); });
  $('#tourSkip').addEventListener('click', tourStop);
  $('#tourStart').addEventListener('click', function () { tourStart(true); });
  $('#helpHowItWorks').addEventListener('click', openHowItWorks);
  $('#howItWorksTour').addEventListener('click', function () { closeModal('howItWorks'); tourStart(true); });
  $('#emptyTourCta').addEventListener('click', function () { tourStart(true); });

  /* ---- Init ---- */
  refreshTourCta();
  $('#newConnectionBtn').addEventListener('click', openWizard);
  $('#emptyCta').addEventListener('click', openWizard);
  bootstrapAuth();
})();
