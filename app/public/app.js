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
    $$('.topnav__link').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === name); });
    $('#view-connections').hidden = name !== 'connections';
    $('#view-lists').hidden = name !== 'lists';
    $('#view-knowledge').hidden = name !== 'knowledge';
    $('#view-invites').hidden = name !== 'invites';
    $('#view-settings').hidden = name !== 'settings';
    if (name === 'settings') loadInfo();
    if (name === 'lists') loadLists();
    if (name === 'knowledge') loadKnowledge();
    if (name === 'invites') loadInvitesView();
  }
  $$('.topnav__link').forEach(function (btn) {
    btn.addEventListener('click', function () { showView(btn.dataset.view); });
  });

  /* ---- Status helpers ---- */
  var STATUS = {
    active: { label: 'Active', cls: 'chip--success' },
    pending_google: { label: 'Awaiting Google', cls: 'chip--warning' },
    disconnected: { label: 'Disconnected', cls: 'chip--neutral' }
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
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>'
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
      ['accepted', 'confirmed', 'rsvp-yes', 'Confirmed email automation', 'success'],
      ['tentative', 'tentative', 'rsvp-maybe', 'Tentative nurture automation', 'warning'],
      ['declined', 'cancelled', 'rsvp-no + DND', 'Stop communication', 'danger'],
      ['needsAction', 'pending', 'rsvp-pending', 'No change', 'neutral']
    ];
    return '<table class="map"><thead><tr><th>Google RSVP</th><th>GHL status</th><th>Tags</th><th>Trigger</th></tr></thead><tbody>' +
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
      '<h3 class="detail__sub">RSVP → GHL mapping</h3>' + mappingTable();
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

  function loadCatalog() {
    return api('/api/integrations').then(function (d) {
      CATALOG = d.integrations || [];
    });
  }

  function fieldMeta(fieldKey) {
    for (var i = 0; i < CATALOG.length; i++) {
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
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: '',
      enabled: true,
      conditions: [{ field: 'responseStatus', operator: 'equals', value: '' }],
      webhookUrl: ''
    };
  }

  function openAutomations(id) {
    var c = state.connections.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    automationsId = id;
    editingRules = (c.rules || []).map(function (r) { return JSON.parse(JSON.stringify(r)); });

    var mode = c.ghlDeliveryMode || 'both';
    $$('#automationsBody input[name="deliveryMode"]').forEach(function (r) { r.checked = r.value === mode; });

    (CATALOG.length ? Promise.resolve() : loadCatalog()).then(function () {
      renderRules();
      loadSnapshot(id);
      openModal('automations');
    });
  }

  function renderRules() {
    var el = $('#rulesList');
    el.innerHTML = '';
    if (editingRules.length === 0) {
      el.innerHTML = '<p class="muted">No rules yet — add one below.</p>';
    }
    editingRules.forEach(function (rule) { el.appendChild(ruleEl(rule)); });
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
      rule.conditions.push({ field: 'responseStatus', operator: 'equals', value: '' });
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
        el.textContent = d.snapshot ? JSON.stringify(d.snapshot, null, 2) : 'No sample yet — sync an RSVP change to capture one.';
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
        .then(function () { toast('Bootstrap started', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (action === 'detail') {
      openDetail(id);
    } else if (action === 'edit') {
      openEdit(id);
    } else if (action === 'automations') {
      openAutomations(id);
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

  function loadInvitesView() {
    var tz = document.getElementById('inviteTimezone');
    if (tz && !tz.value) {
      try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    }
    return Promise.all([
      api('/api/connections').then(function (d) {
        inviteConnections = (d.connections || []).filter(function (c) { return c.status === 'active'; });
      }),
      api('/api/lists').then(function (d) {
        inviteLists = (d.lists || []).filter(function (l) { return l.hasResult; });
      }),
      loadInviteHistory()
    ]).then(function () {
      renderInviteConnections();
      renderInviteLists();
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderInviteConnections() {
    var sel = document.getElementById('inviteConnection');
    var prev = sel.value;
    sel.innerHTML = '';
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
    var allLab = document.createElement('label');
    allLab.className = 'check';
    allLab.innerHTML = '<input type="checkbox" id="inviteSegAll" checked /> <span>All segments</span>';
    wrap.appendChild(allLab);
    segs.forEach(function (s) {
      var rows = Array.isArray(s.rows) ? s.rows.length : 0;
      var lab = document.createElement('label');
      lab.className = 'check';
      lab.innerHTML = '<input type="checkbox" class="invite-seg" value="' + esc(s.name) + '" /> <span>' + esc(s.name) + ' <em class="muted">(' + rows + ')</em></span>';
      wrap.appendChild(lab);
    });
    allLab.querySelector('input').addEventListener('change', function () {
      var on = allLab.querySelector('input').checked;
      $$('#inviteSegments .invite-seg').forEach(function (cb) { cb.checked = false; cb.disabled = on; });
      refreshInvitePreview();
    });
    $$('#inviteSegments .invite-seg').forEach(function (cb) {
      cb.addEventListener('change', refreshInvitePreview);
    });
  }

  function refreshInvitePreview() {
    var listId = document.getElementById('inviteList').value;
    var el = document.getElementById('inviteRecipients');
    if (!listId) { el.textContent = 'Select a list to preview recipients.'; return; }
    api('/api/invites/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: listId, segments: selectedInviteSegments() }) })
      .then(function (d) {
        el.innerHTML = '<strong>' + d.emails.length + '</strong> recipients · ' +
          '<span class="muted">' + d.duplicatesRemoved + ' duplicates · ' + (d.invalid ? d.invalid.length : 0) + ' invalid · ' + (d.alreadyInvited ? d.alreadyInvited.length : 0) + ' already invited</span>';
      })
      .catch(function (e) { el.textContent = 'Preview failed: ' + e.message; });
  }

  function loadInviteHistory() {
    return api('/api/invites').then(function (d) { renderInviteHistory(d.invites || []); }).catch(function () {});
  }

  function renderInviteHistory(invites) {
    var el = document.getElementById('inviteHistory');
    if (!invites.length) {
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('send') + '</div><h2 class="empty__title">No invites yet</h2></div>';
      return;
    }
    el.innerHTML = '<table class="map"><thead><tr><th>Event</th><th>List</th><th>Calendar</th><th>Recipients</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody>' +
      invites.map(function (inv) {
        var links = inv.batches && inv.batches.length
          ? inv.batches.map(function (b) { return b.htmlLink ? '<a href="' + esc(b.htmlLink) + '" target="_blank" rel="noopener">event</a>' : esc(b.eventId || ''); }).join(', ')
          : '—';
        return '<tr>' +
          '<td>' + esc(inv.summary) + '</td>' +
          '<td>' + esc(inv.listName) + '</td>' +
          '<td>' + esc(inv.connectionName) + '</td>' +
          '<td>' + inv.recipientCount + '</td>' +
          '<td>' + esc(inv.status) + '</td>' +
          '<td>' + new Date(inv.createdAt).toLocaleString() + '</td>' +
          '<td>' + links + ' <button class="btn btn--ghost btn--sm" data-action="deleteInvite" data-id="' + esc(inv.id) + '">Delete</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
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
      document.getElementById('inviteRecipients').textContent = 'Select a list to preview recipients.';
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
    if (!connId) { toast('Choose a calendar connection', 'error'); return; }
    if (!listId) { toast('Choose a segmented list', 'error'); return; }
    if (!summary) { toast('Event title is required', 'error'); return; }
    if (!start || !end) { toast('Set a start and end time', 'error'); return; }
    if (new Date(end) <= new Date(start)) { toast('End must be after start', 'error'); return; }

    api('/api/invites/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: listId, segments: selectedInviteSegments() }) })
      .then(function (p) {
        if (!p.emails.length) { toast('No recipients to invite (already invited or invalid)', 'error'); return; }
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
                toast('Invites sent (' + r.sent + ' recipients)', r.ok ? 'success' : 'error');
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

  /* ---- Settings ---- */
  function loadInfo() {
    $('#settingsCards').innerHTML = '<div class="skeleton skel-card" style="height:180px"></div><div class="skeleton skel-card" style="height:180px"></div>';
    return api('/api/info').then(function (info) {
      $('#settingsCards').innerHTML = aiCard() + securityCard(info) + brandingCard();
      wireAi();
      loadAiSettings();
    }).catch(function (err) { $('#settingsCards').innerHTML = '<div class="card"><p class="muted">' + esc(err.message) + '</p></div>'; });
  }
  function brandingCard() {
    return '<div class="card"><h3 class="card__title">Branding</h3>' +
      '<div class="brand-swatch"><img src="/static/logo.png" alt="Vibesuite logo" class="brand-swatch__logo" /></div>' +
      '<p class="muted">Vibesuite — Google Calendar RSVP to GoHighLevel sync.</p></div>';
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
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('list') + '</div><h2 class="empty__title">No lists yet</h2><p class="empty__text">Upload a list and let the AI segment it into groups.</p><button class="btn btn--accent" id="emptyListsCta">New list</button></div>';
      $('#emptyListsCta').addEventListener('click', function () { $('#newListForm').reset(); openModal('newList'); });
      return;
    }
    el.innerHTML = '<div class="summary">' +
      '<div class="summary__item"><span class="summary__value">' + lists.length + '</span><span class="summary__label">lists</span></div>' +
      '<div class="summary__item"><span class="summary__value">' + lists.filter(function (l) { return l.hasResult; }).length + '</span><span class="summary__label">segmented</span></div>' +
      '</div>';
    lists.forEach(function (l) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(l.name) + '</span>' + (l.hasResult ? '<span class="chip chip--success">Segmented</span>' : '<span class="chip chip--neutral">Pending</span>') + '</div>' +
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
      .then(function () { toast('Segmentation complete', 'success'); loadLists(); viewListResult(id); })
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
      el.innerHTML = '<div class="empty"><div class="empty__icon">' + icon('book') + '</div><h2 class="empty__title">No documents yet</h2><p class="empty__text">Add context the AI can use when segmenting lists.</p><button class="btn btn--accent" id="emptyKnowledgeCta">Add document</button></div>';
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

  /* ---- Init ---- */
  $('#newConnectionBtn').addEventListener('click', openWizard);
  $('#emptyCta').addEventListener('click', openWizard);
  loadCatalog();
  showView('connections');
  load();
})();
