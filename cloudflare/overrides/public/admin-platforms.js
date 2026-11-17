// Admin Platforms for the Workers runtime: switch each platform on or off
// (/api/admin/platforms). Same page contract as the Docker script; the
// differences are Worker-secrets wording, missing credentials listed one per
// line, and a roomier table layout (the Docker markup marks most columns
// nowrap, which starves the Platform column).

(function () {
  const style = document.createElement('style');
  style.textContent = `
    table.platforms-table { table-layout: auto; width: 100%; }
    table.platforms-table th, table.platforms-table td { white-space: normal; vertical-align: top; }
    table.platforms-table td.platform-col { min-width: 15rem; }
    table.platforms-table td.count-col, table.platforms-table td.action-col { white-space: nowrap; }
    .cred-list { margin: 2px 0 0; padding-left: 1.1rem; }
    .cred-list li { font-family: ui-monospace, monospace; font-size: 0.85em; }
    .setup-secrets { list-style: none; margin: 4px 0 0; padding: 0; }
    .setup-secrets li { margin: 2px 0; }
  `;
  document.head.appendChild(style);

  const table = document.querySelector('table.admin-table');
  if (table) table.classList.add('platforms-table');

  // The shared hint still talks about .env and restarting the app.
  document.querySelectorAll('.admin-section .hint').forEach((hint) => {
    if (hint.textContent.includes('.env')) {
      hint.innerHTML = hint.innerHTML
        .replace(/app credentials in <code>\.env<\/code>/, 'app credentials set as Worker secrets')
        .replace(/ \(restart the app after editing <code>\.env<\/code>\)/, ' (secrets apply on the next deploy)')
        .replace(/editing <code>\.env<\/code>/, 'editing Worker secrets');
    }
  });
})();

function statusCell(p) {
  if (!p.built) return '<span class="admin-chip is-off">Not built yet</span>';
  const label = p.enabled ? 'On' : 'Off';
  const note = p.switchedAt ? '' : ' <span class="hint">(default)</span>';
  return `<span class="admin-chip ${p.enabled ? 'is-on' : 'is-off'}">${label}</span>${note}`;
}

function credentialsCell(p) {
  if (!p.built) return '—';
  if (!p.credentialsNeeded) return 'Not needed';
  if (p.credentialsSet) return 'Set';
  const missing = Array.isArray(p.credentialsMissing) && p.credentialsMissing.length
    ? p.credentialsMissing
    : p.credentialsNeeded.split(',').map((name) => name.trim());
  return `<span class="admin-bad">Missing</span><ul class="cred-list">${missing
    .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
    .join('')}</ul>`;
}

function actionsCell(p) {
  if (!p.built) return '';
  const toggle = `<button type="button" class="${p.enabled ? 'btn-secondary' : ''}" data-switch="${p.id}" data-enabled="${!p.enabled}">${
    p.enabled ? 'Turn off' : 'Turn on'
  }</button>`;
  const reset = p.switchedAt ? ` <button type="button" class="btn-secondary" data-reset="${p.id}">Reset to default</button>` : '';
  return toggle + reset;
}

// "How to set up": developer console, callback URL(s) to register there (copyable), and which
// Worker secrets are set (never their values).
function setupDetails(p) {
  const setup = p.setup;
  if (!p.built || !setup) return '';
  const parts = [`<p>${escapeHtml(setup.steps)}</p>`];
  if (setup.console) {
    parts.push(
      `<p>Developer console: <a href="${escapeHtml(setup.console)}" target="_blank" rel="noopener">${escapeHtml(setup.console)} ↗</a></p>`
    );
  }
  if (setup.callbackUrls.length) {
    parts.push(
      `<p>Callback URL${setup.callbackUrls.length > 1 ? 's' : ''} to register:</p>` +
        setup.callbackUrls
          .map(
            (url) =>
              `<div class="setup-copy"><code>${escapeHtml(url)}</code> <button type="button" class="btn-secondary" data-copy="${escapeHtml(url)}">Copy</button></div>`
          )
          .join('')
    );
  }
  if (setup.env.length) {
    parts.push(
      `<p>Worker secrets (set with <code>cf workers secrets update NAME</code>):</p>` +
        `<ul class="setup-secrets">${setup.env
          .map(
            (v) =>
              `<li><code>${escapeHtml(v.name)}</code> ${
                v.set ? '✓' : v.optional ? '<span class="hint">(optional)</span>' : '<span class="admin-bad">not set</span>'
              }</li>`
          )
          .join('')}</ul>`
    );
  }
  return `<details class="platform-setup"><summary>How to set up</summary>${parts.join('')}</details>`;
}

let platforms = [];

async function loadPlatforms() {
  const body = document.getElementById('platforms-body');
  try {
    platforms = await apiJson('/api/admin/platforms');
    body.innerHTML = platforms
      .map(
        (p) =>
          `<tr><td class="platform-col">${escapeHtml(p.label)}${p.sharesConnectWith ? ` <span class="hint">(connects with ${escapeHtml(p.sharesConnectWith)})</span>` : ''}${setupDetails(p)}</td><td class="count-col">${statusCell(
            p
          )}</td><td class="count-col">${credentialsCell(p)}</td><td class="count-col">${p.connectedAccounts}</td><td class="count-col">${p.scheduledPosts}</td><td class="action-col">${actionsCell(p)}</td></tr>`
      )
      .join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Failed to load.</td></tr>';
    showToast(err.message);
  }
}

async function send(id, payload, confirmMessage, confirmText) {
  if (confirmMessage && !(await confirmDialog(confirmMessage, { confirmText }))) return;
  try {
    const result = await apiJson(`/api/admin/platforms/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const label = platforms.find((p) => p.id === id)?.label ?? id;
    showToast(`${label} is now ${result.enabled ? 'on' : 'off'}.`, 'success');
    loadPlatforms();
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('platforms-body').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    navigator.clipboard
      .writeText(copyBtn.dataset.copy)
      .then(() => showToast('Copied.', 'success'))
      .catch(() => showToast('Select the URL and copy it with Ctrl+C.', 'warning'));
    return;
  }
  const switchBtn = e.target.closest('[data-switch]');
  if (switchBtn) {
    const p = platforms.find((x) => x.id === switchBtn.dataset.switch);
    const enable = switchBtn.dataset.enabled === 'true';
    let message = null;
    if (enable && !p.credentialsSet) {
      message = `${p.label} has no app credentials set yet, so connecting will fail until they're added. Turn it on anyway?`;
    } else if (!enable && (p.connectedAccounts || p.scheduledPosts)) {
      message = `Turn off ${p.label}? ${p.connectedAccounts} connected account(s) will stop publishing, and ${p.scheduledPosts} scheduled post(s) will fail when due.`;
    } else if (!enable) {
      message = `Turn off ${p.label}? It will be hidden and can't be connected.`;
    }
    send(p.id, { enabled: enable }, message, enable ? 'Turn on' : 'Turn off');
    return;
  }
  const resetBtn = e.target.closest('[data-reset]');
  if (resetBtn) {
    const p = platforms.find((x) => x.id === resetBtn.dataset.reset);
    send(p.id, { reset: true }, `Reset ${p.label} to its default (${p.defaultEnabled ? 'on' : 'off'})?`, 'Reset');
  }
});

loadPlatforms();
