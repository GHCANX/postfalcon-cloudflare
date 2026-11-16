import { Hono } from "hono";

import {
  findUnboundScheduledPosts,
  recordWorkflowInstance,
  releaseExpiredDeliveryLeases,
  workflowInstanceId,
} from "./lib/delivery";
import { ScheduledPostDelivery } from "./workflows/post-delivery";

type Bindings = { Bindings: Env };

const app = new Hono<Bindings>();

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
