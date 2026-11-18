// Admin Overview for the Workers runtime: renders GET /api/admin/overview
// (src/routes/admin.ts) and POST /api/admin/email/test. Sections whose backend
// does not exist yet are hidden rather than faked; they appear as their steps
// land (failed posts, version, backups detail, alerts, business).

function when(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function ago(value) {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function mibs(n) {
  return n == null ? '—' : `${Math.round(n * 10) / 10} MiB`;
}

function checkItem(level, title, detail) {
  return `<li class="admin-check admin-check-${level}"><span class="admin-check-badge">${
    { error: 'Fix', warn: 'Check', ok: 'OK' }[level]
  }</span><div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div></li>`;
}

function tile(label, value, sub = '') {
  return `<div class="an-tile"><span class="an-tile-label">${escapeHtml(label)}</span><span class="an-tile-value">${escapeHtml(
    String(value)
  )}</span>${sub ? `<span class="an-tile-sub">${escapeHtml(sub)}</span>` : ''}</div>`;
}

function rowsOrEmpty(rows, columns, empty) {
  if (!rows.length) return `<tr><td colspan="${columns}" class="empty">${escapeHtml(empty)}</td></tr>`;
  return rows.join('');
}

function hideSection(containingId) {
  const el = document.getElementById(containingId);
  const section = el && el.closest('section.admin-section');
  if (section) section.hidden = true;
}

function renderSetup(data) {
  const bad = /never run|overdue|failed|review|stuck|reconnect|no owner/i;
  const warn = /held|80%|90%|paused/i;
  document.getElementById('setup-checks').innerHTML = data.problems.length
    ? data.problems.map((p) => checkItem(bad.test(p) ? 'error' : warn.test(p) ? 'warn' : 'ok', p)).join('')
    : checkItem('ok', 'No problems right now', '');
  const adapters = (data.publishing && data.publishing.adapters) || [];
  document.getElementById('setup-platforms').innerHTML = adapters
    .map((id) => `<span class="admin-chip is-on">✓ ${escapeHtml(PLATFORM_META[id]?.label || id)}</span>`)
    .join('');
}

function renderScheduler(scheduler, posts) {
  const items = [];
  if (!scheduler) {
    items.push(checkItem('warn', 'The scheduler has not reported yet', 'It runs every minute; the first report appears within a few minutes of deploy.'));
  } else {
    const age = scheduler.secondsAgo;
    if (age === null || age === undefined) {
      items.push(checkItem('error', 'The scheduler has never run', 'Scheduled posts will not publish.'));
    } else if (age > 5 * 60) {
      items.push(checkItem('error', `Last run ${ago(scheduler.lastRunAt)}`, 'It should run every minute.'));
    } else {
      items.push(checkItem('ok', `Running — last run ${ago(scheduler.lastRunAt)}`, `Status: ${scheduler.status}.`));
    }
    if (scheduler.status === 'failed') items.push(checkItem('error', 'Last run failed', 'Check the Worker logs.'));
  }
  if (posts) {
    const p = posts;
    if (p.overdue > 0) items.push(checkItem('error', `${p.overdue} scheduled post(s) overdue`, 'Due more than 5 minutes ago.'));
    if (p.posting > 0) items.push(checkItem('warn', `${p.posting} post(s) mid-publish`, 'Stuck ones move to review after 5 minutes.'));
    if (p.review_required > 0) items.push(checkItem('error', `${p.review_required} post(s) need manual review`, 'See Admin → Activity.'));
    if (p.budget_hold > 0) items.push(checkItem('warn', `${p.budget_hold} post(s) held`, 'The R2 read budget is spent; they resume automatically next month.'));
    items.push(checkItem('ok', `${p.posted_7d} published / ${p.failed_7d} failed in 7 days`, `${p.scheduled} scheduled, ${p.drafts} drafts.`));
  }
  document.getElementById('scheduler-status').innerHTML = items.join('');
}

function renderPublishing(publishing, reconnect) {
  document.getElementById('publishing-by-platform').innerHTML = rowsOrEmpty(
    (publishing.byPlatform || []).map(
      (r) => `<tr><td>${escapeHtml(r.platform)}</td><td class="nowrap">${r.posted}</td><td class="nowrap${r.failed ? ' admin-bad' : ''}">${r.failed}</td></tr>`
    ),
    3,
    'Nothing published or failed in the last 24 hours.'
  );
  document.getElementById('publishing-reconnect').innerHTML = rowsOrEmpty(
    (reconnect || []).map(
      (a) =>
        `<tr><td class="nowrap">${when(a.needs_reconnect_at ? new Date(a.needs_reconnect_at * 1000).toISOString() : null)}</td><td class="nowrap">${escapeHtml(
          a.platform
        )}</td><td>${escapeHtml(a.display_name || '')}</td><td>${escapeHtml(a.email || '—')}</td><td>${escapeHtml((a.reconnect_reason || '').slice(0, 200))}</td></tr>`
    ),
    5,
    'None.'
  );
}

function renderStorage(r2) {
  const tiles = document.getElementById('storage-tiles');
  if (!r2) {
    tiles.innerHTML = tile('Error', '!', 'R2 budget state is missing.');
    return;
  }
  tiles.innerHTML = [
    tile('Media stored', mibs(r2.mediaMiB), `of ${mibs(r2.caps.mediaMiB)} cap`),
    tile('Total stored', mibs(r2.totalMiB), `of ${mibs(r2.caps.totalMiB)} cap`),
    tile('Class A operations', r2.classAOperations.toLocaleString(), `of ${r2.caps.classAOperations.toLocaleString()} this month (${r2.percentOfCap.classA ?? '—'}%)`),
    tile('Class B operations', r2.classBOperations.toLocaleString(), `of ${r2.caps.classBOperations.toLocaleString()} this month (${r2.percentOfCap.classB ?? '—'}%)`),
    tile('Largest file', `${r2.caps.objectMiB} MiB`, 'chunked uploads; 25 MiB in one request'),
  ].join('');
  document.getElementById('storage-note').textContent =
    'Hard caps fail closed: at 100% uploads or platform reads pause until the monthly counters reset. Media is never deleted to stay under them.';
}

// Email (Mailgun): the form when configured, the secrets commands when not,
// and the last few recorded deliveries either way.
function renderEmail(email) {
  const section = document.getElementById('test-email-form').closest('section.admin-section');
  const form = document.getElementById('test-email-form');
  const result = document.getElementById('test-email-result');

  let status = document.getElementById('email-status');
  if (!status) {
    status = document.createElement('p');
    status.id = 'email-status';
    status.className = 'hint';
    section.insertBefore(status, form);
  }
  if (email.configured) {
    form.hidden = false;
    status.textContent = `Sending as ${email.from || 'the configured sender'} via ${email.domain || 'Mailgun'}${email.region ? ` (${email.region})` : ''}.`;
  } else {
    form.hidden = true;
    status.textContent = 'Email is not configured, so nothing is sent (not even alerts). Set these once on the Worker — they cannot be saved from this page:';
    const pre = document.createElement('pre');
    pre.className = 'hint';
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent =
      'cf workers secrets update MAILGUN_API_KEY --worker postfalcon-staging --type secret_text --text <key>\n' +
      'cf workers secrets update MAILGUN_DOMAIN  --worker postfalcon-staging --type secret_text --text mg.example.com\n' +
      'cf workers secrets update MAILGUN_FROM    --worker postfalcon-staging --type secret_text --text "Postfalcon <postfalcon@mg.example.com>"\n' +
      'cf workers secrets update MAILGUN_REGION  --worker postfalcon-staging --type secret_text --text eu   # only for the EU region';
    if (!document.getElementById('email-secrets')) {
      pre.id = 'email-secrets';
      section.insertBefore(pre, status.nextSibling);
    }
  }

  let deliveries = document.getElementById('email-deliveries');
  if (!deliveries) {
    deliveries = document.createElement('div');
    deliveries.id = 'email-deliveries';
    deliveries.className = 'admin-table-wrap';
    section.appendChild(deliveries);
  }
  deliveries.innerHTML = rowsOrEmpty(
    (email.deliveries || []).map(
      (d) =>
        `<tr><td class="nowrap">${when(d.created_at)}</td><td class="nowrap">${escapeHtml(d.category)}</td><td>${escapeHtml(
          d.recipient
        )}</td><td class="nowrap${d.status === 'failed' ? ' admin-bad' : ''}">${escapeHtml(d.status)}</td><td>${escapeHtml(
          (d.error_message || '').slice(0, 160)
        )}</td></tr>`
    ),
    5,
    'No emails recorded yet.'
  );
  const heading = deliveries.previousElementSibling;
  if (!heading || heading.id !== 'email-deliveries-heading') {
    const h = document.createElement('h3');
    h.id = 'email-deliveries-heading';
    h.className = 'admin-subhead';
    h.textContent = 'Recent deliveries';
    deliveries.before(h);
  }
}

function renderBackups(backups) {
  const note = document.getElementById('backups-note');
  const button = document.getElementById('backup-now');
  if (backups && backups.configured) {
    note.textContent = backups.lastAt
      ? `Weekly D1 export to R2 (Sundays 03:45 UTC, last four kept). Last copy: ${when(backups.lastAt)}. Time Travel covers the last 7 days.`
      : 'Weekly D1 export to R2 is on (Sundays 03:45 UTC, last four kept); no copy has been made yet. Time Travel covers the last 7 days.';
    button.hidden = false;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await apiJson('/api/admin/backup', { method: 'POST' });
        showToast('Backup started; it takes about a minute.', 'success');
      } catch (error) {
        showToast(error.message || 'Could not start the backup.', 'error');
      } finally {
        button.disabled = false;
      }
    };
  } else {
    note.textContent = `${(backups && backups.setup) || 'Weekly exports are not set up.'} Until then the database is restored with Time Travel (up to 7 days back).`;
    button.hidden = true;
  }
  const table = document.getElementById('backup-rows').closest('.admin-table-wrap');
  if (table) table.hidden = true;
  const restore = table && table.nextElementSibling;
  if (restore && restore.classList.contains('platform-setup')) {
    restore.hidden = false;
    restore.innerHTML = `
      <summary>How to restore from Time Travel</summary>
      <p>In the Cloudflare dashboard open <strong>D1 → the database → Time Travel</strong>, pick a point before the problem, and restore. Everything after that point is replaced — including posts that may already have gone out, so afterwards turn overdue scheduled posts back into drafts before they can publish twice:</p>
      <p><code>UPDATE posts SET status = 'draft' WHERE status IN ('scheduled','posting') AND scheduled_for &lt; now();</code></p>
      <p>Run it from <code>cf d1 query &lt;database-id&gt; --command "…"</code> or the dashboard's D1 console. Media in R2 is not part of the restore.</p>`;
  }
  const dir = document.getElementById('backup-dir');
  if (dir) dir.textContent = 'D1 Time Travel';
}

// Alerts (lib/alerts.ts, via /api/admin/alerts[/check]): problems admins are or
// will be emailed about, checked by the 15-minute maintenance pass.
function renderAlerts(data) {
  const list = document.getElementById('alerts-list');
  list.innerHTML = data.alerts.length
    ? data.alerts.map((a) => checkItem('error', a.title, `${a.detail || ''} Since ${when(a.active_since)}.`)).join('')
    : checkItem('ok', 'No problems right now', '');
  let note = 'Checked every 15 minutes; admins are emailed when a problem starts, daily while it lasts, and when it clears.';
  if (!data.emailsOn) note = 'Checked every 15 minutes. Alert emails are off (Admin → Settings), so problems only show here.';
  else if (!data.emailConfigured) note += " Email isn't set up on this server, so they're only recorded here.";
  document.getElementById('alerts-note').textContent = note;
}

async function loadAlerts() {
  try {
    renderAlerts(await apiJson('/api/admin/alerts'));
  } catch (err) {
    document.getElementById('alerts-list').innerHTML = checkItem('warn', "Couldn't load alerts", err.message);
  }
}

const alertsBtn = document.getElementById('alerts-check');
alertsBtn.addEventListener(
  'click',
  withLoading(alertsBtn, 'Checking…', async () => {
    try {
      const result = await apiJson('/api/admin/alerts/check', { method: 'POST' });
      renderAlerts(result);
      const sent = result.emailedTo && result.emailedTo.length ? ` Emailed ${result.emailedTo.length} admin(s).` : '';
      const active = result.alerts.length;
      showToast(`${active ? `${active} problem(s) active.` : 'No problems found.'}${sent}`, active ? 'warning' : 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

// Failed posts across the board (GET /api/admin/failed-posts), retried alone or all shown.
let failedPostIds = [];

async function loadFailedPosts() {
  const body = document.getElementById('publishing-failures');
  const params = new URLSearchParams({ hours: document.getElementById('failed-hours').value });
  const platform = document.getElementById('failed-platform').value;
  if (platform) params.set('platform', platform);
  try {
    const posts = await apiJson(`/api/admin/failed-posts?${params}`);
    failedPostIds = posts.map((f) => f.id);
    const retryAll = document.getElementById('failed-retry-all');
    retryAll.disabled = posts.length === 0;
    retryAll.textContent = posts.length ? `Retry all ${posts.length} shown` : 'Retry all shown';
    body.innerHTML = rowsOrEmpty(
      posts.map(
        (f) =>
          `<tr><td class="nowrap">${when(f.updated_at)}</td><td class="nowrap">${escapeHtml(f.platform)}</td><td>${escapeHtml(
            f.display_name || ''
          )}</td><td>${escapeHtml(f.email || '')}</td><td>${escapeHtml((f.error_message || '').slice(0, 300))}</td><td class="nowrap"><button type="button" class="btn-secondary" data-retry-post="${
            f.id
          }">Retry</button></td></tr>`
      ),
      6,
      'No failed posts in this window.'
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">Couldn't load failed posts: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function retryPosts(ids, confirmMessage) {
  if (confirmMessage && !(await confirmDialog(confirmMessage, { confirmText: 'Retry' }))) return;
  try {
    const { retried } = await apiJson('/api/admin/failed-posts/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    showToast(`${retried.length} post${retried.length === 1 ? '' : 's'} queued again; they go out within a minute.`, 'success');
    loadFailedPosts();
  } catch (err) {
    showToast(err.message);
  }
}

const failedPlatform = document.getElementById('failed-platform');
failedPlatform.innerHTML += ['mastodon', 'bluesky', 'telegram', 'facebook', 'instagram', 'threads', 'youtube', 'pinterest', 'linkedin', 'tiktok']
  .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
  .join('');
document.getElementById('failed-hours').addEventListener('change', loadFailedPosts);
failedPlatform.addEventListener('change', loadFailedPosts);
document.getElementById('failed-retry-all').addEventListener('click', () =>
  retryPosts(failedPostIds, `Retry all ${failedPostIds.length} failed posts shown? They go out on the next scheduler run.`)
);
document.getElementById('publishing-failures').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-retry-post]');
  if (btn) retryPosts([Number(btn.dataset.retryPost)]);
});

// Version: the deployed Worker Version id (no GitHub comparison on Workers).
function renderVersion(version) {
  const list = document.getElementById('version-status');
  if (!version) {
    list.innerHTML = checkItem('warn', 'Version metadata unavailable', 'The VERSION_METADATA binding is not present in this deployment.');
    return;
  }
  list.innerHTML = checkItem('ok', `Deployed version ${version.id.slice(0, 8)}`, `Uploaded ${when(version.timestamp)}. Database migrations show under Setup → Scheduler counts.`);
}

async function loadOverview() {
  document.getElementById('overview-loading').hidden = true;
  document.getElementById('overview-content').hidden = false;
  loadAlerts();
  loadFailedPosts();
  try {
    const data = await apiJson('/api/admin/overview');
    renderSetup(data);
    renderScheduler(data.scheduler, data.posts);
    renderPublishing(data.publishing, data.accountsNeedingReconnect);
    renderStorage(data.r2);
    renderEmail(data.email || { configured: false, deliveries: [] });
    renderBackups(data.backups);
    renderVersion(data.version);
  } catch (err) {
    document.getElementById('overview-loading').textContent = 'Failed to load the overview.';
    showToast(err.message);
    return;
  }
  // Not ported: business tiles (single-owner instance, no billing).
  hideSection('business-tiles');
}

const testEmailForm = document.getElementById('test-email-form');
testEmailForm.addEventListener(
  'submit',
  withLoading(testEmailForm.querySelector('button'), 'Sending…', async (e) => {
    e.preventDefault();
    const result = document.getElementById('test-email-result');
    const to = document.getElementById('test-email-to').value.trim();
    result.textContent = '';
    try {
      const sent = await apiJson('/api/admin/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(to ? { to } : {}),
      });
      result.textContent = sent.sent
        ? `Sent from ${sent.from} to ${sent.to}. Check that inbox (and its spam folder).`
        : `Not sent: ${sent.response || 'unknown error'}`;
      loadOverview();
    } catch (err) {
      result.textContent = `Not sent: ${err.message}`;
    }
  })
);

const refreshBtn = document.getElementById('overview-refresh');
refreshBtn.addEventListener('click', withLoading(refreshBtn, 'Refreshing…', loadOverview));
loadOverview();
