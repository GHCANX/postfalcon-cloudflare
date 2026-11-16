import { Hono } from "hono";

import { type AppEnv, csrfProtection, requireConfiguredSecrets } from "./lib/auth";
import {
  findUnboundScheduledPosts,
  recordWorkflowInstance,
  releaseExpiredDeliveryLeases,
  workflowInstanceId,
} from "./lib/delivery";
import { purgeRateLimits } from "./lib/rate-limit";
import { purgeExpiredSessions } from "./lib/sessions";
import { accountRoutes } from "./routes/accounts";
import { authRoutes } from "./routes/auth";
import { connectRoutes } from "./routes/connect";
import { ScheduledPostDelivery } from "./workflows/post-delivery";

const app = new Hono<AppEnv>();

// The same policy the Docker app sets through helmet: no inline script or
// style, nothing loaded from another origin, never framed.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("Cross-Origin-Opener-Policy", "same-origin");
});

// Every /api response is per-user, so none of it may be cached.
app.use("/api/*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
});
app.use("/api/*", requireConfiguredSecrets, csrfProtection);
app.route("/api", authRoutes);
app.route("/api", connectRoutes);
app.route("/api/social-accounts", accountRoutes);
app.route("/api/v1/social-accounts", accountRoutes);

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensurePostDeliveryWorkflows(env: Env, workflow: Workflow<{ postId: number; scheduledFor: number }>) {
  const unboundPosts = await findUnboundScheduledPosts(env.DB);
  let created = 0;
  let repaired = 0;

  for (const post of unboundPosts) {
    const id = workflowInstanceId(post);
    try {
      await workflow.create({ id, params: post });
      created += 1;
    } catch (error) {
      // A previous invocation may have created the deterministic instance then
      // stopped before recording it in D1. Confirm it exists before repairing.
      try {
        await workflow.get(id);
        repaired += 1;
      } catch {
        throw error;
      }
    }
    await recordWorkflowInstance(env.DB, post, id);
  }

  return { created, repaired, scanned: unboundPosts.length };
}

async function runReconciliation(
  env: Env,
  workflow: Workflow<{ postId: number; scheduledFor: number }>,
  scheduledFor: string,
): Promise<void> {
  const run = await env.DB.prepare(
    `INSERT INTO worker_job_runs (job_name, scheduled_for, started_at, status)
     VALUES (?, ?, unixepoch(), 'started')
     RETURNING id`,
  )
    .bind("reconciliation", scheduledFor)
    .first<{ id: number }>();

  if (!run) throw new Error("Could not record reconciliation run");

  try {
    const [delivery, expiredLeases] = await Promise.all([
      ensurePostDeliveryWorkflows(env, workflow),
      releaseExpiredDeliveryLeases(env.DB),
    ]);
    await env.DB
      .prepare(
        `UPDATE worker_job_runs
            SET status = 'completed', completed_at = unixepoch(), details_json = ?
          WHERE id = ?`,
      )
      .bind(JSON.stringify({ delivery, expiredLeases }), run.id)
      .run();
    log("scheduled_reconciliation_completed", { scheduledFor, ...delivery, expiredLeases });
  } catch (error) {
    const message = errorMessage(error);
    await env.DB
      .prepare(
        `UPDATE worker_job_runs
            SET status = 'failed', completed_at = unixepoch(), details_json = ?
          WHERE id = ?`,
      )
      .bind(JSON.stringify({ error: message }), run.id)
      .run();
    throw error;
  }
}

/** Deletes ended sessions and old rate-limit windows. Runs every 15 minutes. */
async function runMaintenance(env: Env): Promise<void> {
  await Promise.all([purgeExpiredSessions(env.DB), purgeRateLimits(env.DB)]);
}

app.get("/healthz", async (context) => {
  try {
    const database = await context.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (database?.ok !== 1) {
      throw new Error("D1 health query did not return the expected result");
    }

    return context.json({ status: "ok", profile: context.env.APP_PROFILE });
  } catch (error) {
    console.error(JSON.stringify({ event: "health_check_failed", error: errorMessage(error) }));
    return context.json({ status: "unavailable" }, 503);
  }
});

app.get("/", (context) =>
  context.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Postfalcon Cloudflare</title></head>
  <body><main><h1>Postfalcon Cloudflare foundation</h1><p>The Cloudflare deployment path is isolated from the existing Docker service while feature parity is built.</p></main></body>
</html>`),
);

app.notFound((context) => context.json({ error: "not_found" }, 404));

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      event: "unhandled_request_error",
      error: errorMessage(error),
      method: context.req.method,
      path: new URL(context.req.url).pathname,
    }),
  );
  return context.json({ error: "internal_error" }, 500);
});

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },

  async scheduled(controller, env, context) {
    const scheduledFor = new Date(controller.scheduledTime).toISOString();
    if (new Date(controller.scheduledTime).getUTCMinutes() % 15 === 0) {
      context.waitUntil(
        runMaintenance(env).catch((error: unknown) =>
          console.error(JSON.stringify({ event: "scheduled_maintenance_failed", scheduledFor, error: errorMessage(error) })),
        ),
      );
    }
    context.waitUntil(
      runReconciliation(env, context.exports.ScheduledPostDelivery, scheduledFor)
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              event: "scheduled_reconciliation_record_failed",
              scheduledFor,
              error: errorMessage(error),
            }),
          ),
        ),
    );
  },
} satisfies ExportedHandler<Env>;

export { ScheduledPostDelivery };
