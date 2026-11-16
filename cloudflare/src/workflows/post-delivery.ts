import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  claimPostForDelivery,
  markReviewRequired,
  type DeliveryParams,
  parseDeliveryParams,
  workflowInstanceId,
} from "../lib/delivery";

export class ScheduledPostDelivery extends WorkflowEntrypoint<Env, DeliveryParams> {
  async run(event: WorkflowEvent<DeliveryParams>, step: WorkflowStep) {
    // Input is validated here, at the platform boundary, before anything reads
    // it: an instance created by `cf workflows instances create --params` gets
    // its payload as a JSON-encoded string, not the object `workflow.create()`
    // delivers, and some runtime versions expose it as `params`.
    const params = parseDeliveryParams(
      (event as WorkflowEvent<DeliveryParams> & { params?: unknown }).params ?? event.payload,
    );
    // Derive the ID from the durable scheduling data rather than trusting a
    // runtime-provided event field. It makes the same ID available to a CLI
    // test, a request path, and Cron reconciliation.
    const instanceId = workflowInstanceId(params);
    const dueAt = params.scheduledFor * 1000;
    if (dueAt > Date.now()) {
      await step.sleepUntil("wait until scheduled delivery", dueAt);
    }

    const claim = await step.do("claim scheduled post", async () =>
      claimPostForDelivery(this.env.DB, params, instanceId),
    );
    if (!claim) {
      return { outcome: "skipped" as const };
    }

    // No platform adapter has been moved to the Worker yet. Failing closed is
    // safer than an automatic retry when a platform may have accepted a post.
    // The Mailgun workstream adds a matching operator alert in this same step.
    await step.do("require manual review until adapter is available", async () => {
      await markReviewRequired(
        this.env.DB,
        claim,
        "No Cloudflare platform adapter is enabled for this post; manual review is required before retrying.",
      );
      return { outcome: "review_required" as const };
    });

    return { outcome: "review_required" as const };
  }
}
