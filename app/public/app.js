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
    $('#view-settings').hidden = name !== 'settings';
    if (name === 'settings') loadInfo();
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
      $('#settingsCards').innerHTML = brandingCard() + securityCard(info);
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
  showView('connections');
  load();
})();
