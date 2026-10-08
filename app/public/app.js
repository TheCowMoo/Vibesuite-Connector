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
    var t = document.createElement('div');
    t.className = 'toast toast--' + (type || 'info');
    t.textContent = message;
    $('#toasts').appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    setTimeout(function () {
      t.classList.remove('is-visible');
      setTimeout(function () { t.remove(); }, 300);
    }, 3400);
  }

  /* ---- Navigation ---- */
  function showView(name) {
    $$('.topnav__link').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === name); });
    $('#view-connections').hidden = name !== 'connections';
    $('#view-lists').hidden = name !== 'lists';
    $('#view-knowledge').hidden = name !== 'knowledge';
    $('#view-settings').hidden = name !== 'settings';
    if (name === 'settings') loadInfo();
    if (name === 'lists') loadLists();
    if (name === 'knowledge') loadKnowledge();
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

      var actions = '';
      if (c.status === 'pending_google') {
        actions += '<a class="btn btn--accent btn--sm" href="/oauth/google/start?connectionId=' + encodeURIComponent(c.id) + '">Connect Google</a>';
      }
      if (c.ghlAuthType === 'oauth') {
        actions += '<a class="btn btn--outline btn--sm" href="/oauth/ghl/start?connectionId=' + encodeURIComponent(c.id) + '">Connect GHL</a>';
      }
      actions += '<button class="btn btn--outline btn--sm" data-action="edit" data-id="' + esc(c.id) + '">Edit</button>';
      actions += '<button class="btn btn--ghost btn--sm" data-action="automations" data-id="' + esc(c.id) + '">Automations</button>';
      actions += '<button class="btn btn--ghost btn--sm" data-action="bootstrap" data-id="' + esc(c.id) + '">Bootstrap</button>';
      actions += '<button class="btn btn--ghost btn--sm" data-action="detail" data-id="' + esc(c.id) + '">Details</button>';
      actions += '<button class="btn btn--danger btn--sm" data-action="delete" data-id="' + esc(c.id) + '">Delete</button>';

      var card = document.createElement('div');
      card.className = 'conn';
      card.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(c.name) + '</span>' + statusChip(c.status) + '</div>' +
          '<div class="conn__meta">' +
            '<span class="conn__cal">&#128197; ' + esc(c.googleCalendarId) + '</span>' +
            badge('Google · ' + googleAuth) + badge('GHL · ' + ghlAuth) +
          '</div>' +
        '</div>' +
        '<div class="conn__actions">' + actions + '</div>';
      list.appendChild(card);
    });
  }

  /* ---- Load ---- */
  function load() {
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
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;
    if (action === 'bootstrap') {
      api('/api/connections/' + id + '/bootstrap', { method: 'POST' })
        .then(function () { toast('Bootstrap started', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); });
    } else if (action === 'detail') {
      openDetail(id);
    } else if (action === 'edit') {
      openEdit(id);
    } else if (action === 'automations') {
      openAutomations(id);
    } else if (action === 'delete') {
      if (!confirm('Delete this connection? Its watch channel will expire on its own.')) return;
      api('/api/connections/' + id, { method: 'DELETE' })
        .then(function () { toast('Connection deleted', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); });
    }
  });

  /* ---- Settings ---- */
  function loadInfo() {
    return api('/api/info').then(function (info) {
      $('#settingsCards').innerHTML = brandingCard() + securityCard(info) + aiCard();
      wireAi();
      loadAiSettings();
    }).catch(function (err) { $('#settingsCards').innerHTML = '<div class="card"><p class="muted">' + esc(err.message) + '</p></div>'; });
  }
  function brandingCard() {
    return '<div class="card"><h3 class="card__title">Branding</h3>' +
      '<div class="brand-swatch"><img src="/static/logo.png" alt="Vibesuite logo" class="brand-swatch__logo" /></div>' +
      '<p class="muted">White logo on Deep Navy. A navy/monochrome logo variant is recommended for light surfaces.</p></div>';
  }
  function securityCard(info) {
    var msg = info.encryptionAtRest
      ? '✅ Stored credentials are encrypted at rest (AES-256-GCM).'
      : '⚠️ CREDENTIALS_ENCRYPTION_KEY is not set — stored tokens are not encrypted.';
    return '<div class="card"><h3 class="card__title">Security</h3>' +
      '<p class="muted">' + esc(msg) + '</p>' +
      '<p class="muted">Google webhooks are validated via per-connection channel tokens.</p></div>';
  }

  /* ---- Lists & Knowledge ---- */
  function loadLists() {
    return api('/api/lists').then(function (d) { renderLists(d.lists || []); }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderLists(lists) {
    var el = $('#listsList');
    el.innerHTML = '';
    if (!lists.length) { el.innerHTML = '<div class="empty"><p class="muted">No lists yet — upload one to segment.</p></div>'; return; }
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
          '<button class="btn btn--ghost btn--sm" data-action="viewResult" data-id="' + esc(l.id) + '">View</button>' +
          '<button class="btn btn--danger btn--sm" data-action="deleteList" data-id="' + esc(l.id) + '">Delete</button>' +
        '</div>';
      el.appendChild(box);
    });
  }

  function segmentList(id) {
    toast('Segmenting…', 'info');
    api('/api/lists/' + id + '/segment', { method: 'POST' })
      .then(function () { toast('Segmentation complete', 'success'); loadLists(); viewListResult(id); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function viewListResult(id) {
    api('/api/lists/' + id).then(function (d) {
      var r = d.list && d.list.result;
      $('#listResultBody').textContent = r ? JSON.stringify(r, null, 2) : 'No result yet — click Segment.';
      openModal('listResult');
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function loadKnowledge() {
    return api('/api/knowledge').then(function (d) { renderKnowledge(d.docs || []); }).catch(function (e) { toast(e.message, 'error'); });
  }

  function renderKnowledge(docs) {
    var el = $('#knowledgeList');
    el.innerHTML = '';
    if (!docs.length) { el.innerHTML = '<div class="empty"><p class="muted">No documents yet — add context for the AI.</p></div>'; return; }
    docs.forEach(function (d) {
      var box = document.createElement('div');
      box.className = 'conn';
      box.innerHTML =
        '<div class="conn__main">' +
          '<div class="conn__head"><span class="conn__name">' + esc(d.name) + '</span></div>' +
          '<div class="conn__meta"><span>' + d.size + ' chars</span></div>' +
        '</div>' +
        '<div class="conn__actions"><button class="btn btn--danger btn--sm" data-action="deleteKnowledge" data-id="' + esc(d.id) + '">Delete</button></div>';
      el.appendChild(box);
    });
  }

  function readFileInto(input, textarea) {
    var f = input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { textarea.value = String(reader.result || ''); };
    reader.readAsText(f);
  }

  $('#listFile').addEventListener('change', function () { readFileInto(this, $('#newListForm [name="content"]')); });
  $('#knowledgeFile').addEventListener('change', function () { readFileInto(this, $('#newKnowledgeForm [name="content"]')); });

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
    else if (btn.dataset.action === 'viewResult') viewListResult(id);
    else if (btn.dataset.action === 'deleteList') {
      if (!confirm('Delete this list?')) return;
      api('/api/lists/' + id, { method: 'DELETE' }).then(function () { toast('Deleted', 'success'); loadLists(); }).catch(function (err) { toast(err.message, 'error'); });
    }
  });

  $('#knowledgeList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'deleteKnowledge') {
      if (!confirm('Delete this document?')) return;
      api('/api/knowledge/' + btn.dataset.id, { method: 'DELETE' }).then(function () { toast('Deleted', 'success'); loadKnowledge(); }).catch(function (err) { toast(err.message, 'error'); });
    }
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
    api('/api/ai/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { $('#aiKey').value = ''; $('#aiStatus').textContent = 'Saved (' + (r.apiKeyMasked || '') + ')'; toast('AI settings saved', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function testAi() {
    $('#aiStatus').textContent = 'Testing…';
    api('/api/ai/test', { method: 'POST' })
      .then(function (d) { $('#aiStatus').textContent = 'Test OK — ' + d.reply; toast('AI test OK', 'success'); })
      .catch(function (e) { $('#aiStatus').textContent = 'Test failed — ' + e.message; toast(e.message, 'error'); });
  }

  /* ---- Modal helpers ---- */
  function openModal(id) { $('#' + id).hidden = false; document.body.classList.add('no-scroll'); }
  function closeModal(id) { $('#' + id).hidden = true; document.body.classList.remove('no-scroll'); }
  $$('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { closeModal(b.dataset.close); });
  });
  $$('.backdrop').forEach(function (m) {
    m.addEventListener('click', function (e) {
      if (e.target === m) { m.hidden = true; document.body.classList.remove('no-scroll'); }
    });
  });

  /* ---- Init ---- */
  $('#newConnectionBtn').addEventListener('click', openWizard);
  $('#emptyCta').addEventListener('click', openWizard);
  loadCatalog();
  showView('connections');
  load();
})();
