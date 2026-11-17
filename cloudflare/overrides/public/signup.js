// First-run owner setup (Cloudflare profile): replaces the Docker sign-up script.
// The form also asks for the SETUP_TOKEN secret and posts to /api/setup, which
// creates the one owner account and signs them in.
const setupForm = document.getElementById('signup-form');

if (setupForm && !setupForm.elements.setup_token) {
  const label = document.createElement('label');
  label.append('Setup token ');
  const input = document.createElement('input');
  input.type = 'password';
  input.name = 'setup_token';
  input.autocomplete = 'off';
  input.required = true;
  input.placeholder = 'The SETUP_TOKEN secret';
  label.append(input);
  setupForm.insertBefore(label, setupForm.querySelector('button[type="submit"]'));
}

setupForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  const errorEl = document.getElementById('error');
  button.disabled = true;
  button.textContent = 'Setting up…';
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value, setup_token: form.setup_token.value }),
    });
    if (res.ok) {
      window.location.href = '/dashboard';
      return;
    }
    const data = await res.json().catch(() => ({}));
    const reasons = {
      already_set_up: 'This server already has an owner. Log in instead.',
      invalid_setup_token: 'That setup token is not correct.',
      not_configured: 'SETUP_TOKEN is not configured on this server yet.',
    };
    errorEl.textContent = reasons[data.error] || data.message || data.error || 'Setup failed';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
