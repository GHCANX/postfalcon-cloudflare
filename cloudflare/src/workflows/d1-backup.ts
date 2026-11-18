import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { backupConfigured, pollExport, pruneBackups, startExport, storeBackup } from "../lib/backup";

const POLL_ATTEMPTS = 20;
const POLL_SECONDS = 15;

/** Weekly D1 export into R2 (backups/). Started by the cron on Sundays, or by the admin. */
export class D1ExportBackup extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const startedAt = Math.floor(Date.now() / 1000);
    const scheduledFor = new Date(startedAt * 1000).toISOString();
    const record = (status: "completed" | "failed", details: Record<string, unknown>) =>
      this.env.DB
        .prepare(
          `INSERT INTO worker_job_runs (job_name, scheduled_for, started_at, completed_at, status, details_json)
           VALUES ('d1_backup', ?, ?, unixepoch(), ?, ?)`,
        )
        .bind(scheduledFor, startedAt, status, JSON.stringify(details))
        .run();

    try {
      if (!backupConfigured(this.env)) throw new Error("Backup secrets are not set (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID)");

      const bookmark = await step.do("start export", async () => startExport(this.env));

      let signedUrl: string | null = null;
      for (let attempt = 1; attempt <= POLL_ATTEMPTS && !signedUrl; attempt += 1) {
        signedUrl = await step.do(`check export ${attempt}`, async () => pollExport(this.env, bookmark));
        if (!signedUrl) await step.sleep(`wait ${attempt}`, `${POLL_SECONDS} seconds`);
      }
      if (!signedUrl) throw new Error("The export did not finish in time");

      // Retries would store a second copy; the step either stores one or fails.
      const stored = await step.do("store in R2", { retries: { limit: 0, delay: 1 } }, async () => storeBackup(this.env, signedUrl!));
      const pruned = await step.do("prune old copies", async () => pruneBackups(this.env));
      await step.do("record", async () => {
        await record("completed", { key: stored.key, byteSize: stored.byteSize, pruned });
      });
      return { key: stored.key, byteSize: stored.byteSize, pruned };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record("failed", { error: message.slice(0, 500) }).catch(() => undefined);
      throw error;
    }
  }
}
