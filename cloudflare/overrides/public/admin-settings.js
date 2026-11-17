// Admin Settings for the Workers runtime: site name and alert emails only.
// The Docker page's Logo, Public website and Customers sections have no
// backend in this profile (single owner, no public site, no logo upload), so
// they're removed before wiring the two forms that do work.

function hideUnsupportedSections() {
  document.querySelectorAll('section.admin-section').forEach((section) => {
    const title = section.querySelector('h2');
    if (!title) return;
    const name = title.textContent.trim();
    if (name === 'Logo' || name === 'Public website' || name === 'Sign-ups' || name === 'Customers') section.remove();
  });
  document.querySelectorAll('a[href="/admin/customers"]').forEach((a) => a.closest('p')?.remove() ?? a.remove());
}

function render(settings) {
  const nameInput = document.getElementById('site-name');
  nameInput.placeholder = settings.siteNameDefault;
  nameInput.value = settings.siteName === settings.siteNameDefault ? '' : settings.siteName;

  const alertSelect = document.getElementById('alert-emails');
  alertSelect.value = settings.alertEmails ? 'on' : 'off';
  alertSelect.disabled = false;
}

async function save(payload, message) {
  try {
    const settings = await apiJson('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    render(settings);
    showToast(message, 'success');
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('site-name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('site-name').value.trim();
  save({ site_name: name || null }, name ? `Site name is now “${name}”.` : 'Site name reset to the default.');
});

document.getElementById('alert-emails-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('alert-emails').value;
  save({ alert_emails: value }, value === 'on' ? 'Alert emails are on.' : 'Alert emails are off.');
});

hideUnsupportedSections();
apiJson('/api/admin/settings')
  .then(render)
  .catch((err) => showToast(err.message));
