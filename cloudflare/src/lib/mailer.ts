export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Short label stored with the delivery record (e.g. "password_reset"). */
  category: string;
  userId?: number | null;
};

export type MailResult = { status: "sent" | "failed" | "skipped"; error?: string };

export function mailConfigured(env: Env): boolean {
  return Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.MAILGUN_FROM);
}

/**
 * Sends one email through Mailgun's HTTP API (Workers cannot speak SMTP) and
 * records it in email_deliveries. Without configuration it does nothing and
 * says so; it never writes message bodies (they can contain reset links) to
 * logs or the database. A single attempt: callers decide whether to retry.
 */
export async function sendMail(env: Env, message: MailMessage): Promise<MailResult> {
  if (!mailConfigured(env)) return { status: "skipped" };

  const row = await env.DB
    .prepare("INSERT INTO email_deliveries (user_id, category, recipient, status) VALUES (?, ?, ?, 'queued') RETURNING id")
    .bind(message.userId ?? null, message.category, message.to)
    .first<{ id: number }>();

  let result: MailResult;
  let mailgunId: string | null = null;
  try {
    const host = env.MAILGUN_REGION === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
    const form = new URLSearchParams({ from: env.MAILGUN_FROM!, to: message.to, subject: message.subject, text: message.text });
    const response = await fetch(`https://${host}/v3/${encodeURIComponent(env.MAILGUN_DOMAIN!)}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      mailgunId = data.id ?? null;
      result = { status: "sent" };
    } else {
      result = { status: "failed", error: `Mailgun answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}` };
    }
  } catch (error) {
    result = { status: "failed", error: `Mailgun request failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
  }

  if (row) {
    await env.DB
      .prepare("UPDATE email_deliveries SET status = ?, mailgun_id = ?, error_message = ? WHERE id = ?")
      .bind(result.status, mailgunId, result.error ?? null, row.id)
      .run();
  }
  return result;
}

/** Everyone who should hear about operational problems: the instance's admins. */
export async function adminRecipients(database: D1Database): Promise<{ id: number; email: string }[]> {
  const { results } = await database.prepare("SELECT id, email FROM users WHERE is_admin = 1 AND suspended_at IS NULL").all<{ id: number; email: string }>();
  return results;
}
