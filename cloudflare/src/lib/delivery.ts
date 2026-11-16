export type DeliveryParams = {
  postId: number;
  scheduledFor: number;
};

export type ScheduledPost = DeliveryParams & {
  workflowInstanceId: string | null;
};

export type ClaimedPost = {
  postId: number;
  leaseToken: string;
  workflowInstanceId: string;
};

function workflowInstanceId(post: DeliveryParams): string {
  return `post-${post.postId}-${post.scheduledFor}`;
}

/**
 * Accepts Workflow input as an object or a JSON-encoded string and returns it
 * only if both fields are safe integers. Throws otherwise, so a malformed
 * instance fails with a clear message instead of claiming nothing forever.
 */
export function parseDeliveryParams(input: unknown): DeliveryParams {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Delivery workflow input is not valid JSON");
    }
  }
  const { postId, scheduledFor } = (value ?? {}) as Partial<DeliveryParams>;
  if (!Number.isSafeInteger(postId) || !Number.isSafeInteger(scheduledFor)) {
    throw new Error("Delivery workflow input needs integer postId and scheduledFor");
  }
  return { postId: postId as number, scheduledFor: scheduledFor as number };
}

function deliveryLeaseToken(): string {
  return crypto.randomUUID();
}

function requireDeliveryClaimValues(post: DeliveryParams, instanceId: string, now: number): void {
  const values: Array<[string, unknown]> = [
    ["postId", post.postId],
    ["scheduledFor", post.scheduledFor],
    ["workflowInstanceId", instanceId],
    ["now", now],
  ];
  const missing = values.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Invalid delivery claim parameters: ${missing.join(", ")}`);
  }
  if (!Number.isSafeInteger(post.postId) || !Number.isSafeInteger(post.scheduledFor) || !Number.isSafeInteger(now)) {
    throw new Error("Invalid delivery claim numeric parameters");
  }
  if (instanceId.length === 0) {
    throw new Error("Invalid empty delivery workflow instance ID");
  }
}

export async function findUnboundScheduledPosts(database: D1Database, limit = 10): Promise<ScheduledPost[]> {
  const result = await database
    .prepare(
      `SELECT id AS postId, scheduled_for AS scheduledFor, workflow_instance_id AS workflowInstanceId
         FROM posts
        WHERE status = 'scheduled'
          AND scheduled_for IS NOT NULL
          AND workflow_instance_id IS NULL
        ORDER BY scheduled_for ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<ScheduledPost>();
  return result.results;
}

/**
 * The workflow ID is deterministic for a particular post/time pair. If a
 * request fails after Workflow creation but before this write, reconciliation
 * can safely find the same instance and repair the D1 pointer.
 */
export async function recordWorkflowInstance(
  database: D1Database,
  post: DeliveryParams,
  instanceId = workflowInstanceId(post),
): Promise<boolean> {
  // RETURNING, not meta.changes: D1 counts rows written by triggers too, and
  // posts_set_updated_at fires whenever updated_at does not move.
  const result = await database
    .prepare(
      `UPDATE posts
          SET workflow_instance_id = ?, updated_at = unixepoch()
        WHERE id = ?
          AND status = 'scheduled'
          AND scheduled_for = ?
          AND workflow_instance_id IS NULL
        RETURNING id`,
    )
    .bind(instanceId, post.postId, post.scheduledFor)
    .first<{ id: number }>();
  return result !== null;
}

/**
 * Claiming is the duplicate-send boundary. Only the caller that transitions
 * the exact scheduled row to `posting` owns the lease. A later workflow,
 * retry, or reconciliation invocation sees zero changed rows and must stop.
 */
export async function claimPostForDelivery(
  database: D1Database,
  post: DeliveryParams,
  instanceId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<ClaimedPost | null> {
  requireDeliveryClaimValues(post, instanceId, now);
  const leaseToken = deliveryLeaseToken();
  const result = await database
    .prepare(
      `UPDATE posts
          SET status = 'posting',
              workflow_instance_id = ?,
              posting_lease_token = ?,
              posting_lease_expires_at = ?,
              publish_attempts = publish_attempts + 1,
              last_publish_attempt_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'scheduled'
          AND scheduled_for = ?
          AND scheduled_for <= ?
        RETURNING id AS postId`,
    )
    .bind(instanceId, leaseToken, now + 120, now, now, post.postId, post.scheduledFor, now)
    .first<{ postId: number }>();

  if (!result) return null;

  await database
    .prepare(
      `INSERT INTO post_delivery_attempts (post_id, workflow_instance_id, lease_token, outcome, detail)
       VALUES (?, ?, ?, 'claimed', 'delivery lease acquired')`,
    )
    .bind(result.postId, instanceId, leaseToken)
    .run();

  return { postId: result.postId, leaseToken, workflowInstanceId: instanceId };
}

export async function markReviewRequired(
  database: D1Database,
  claim: ClaimedPost,
  reason: string,
): Promise<void> {
  // One transaction: the audit row is written only while this caller still
  // holds the lease, then the lease is released. A half-applied result would
  // make the Workflow step retry against a lease it had already given up.
  // Ownership is read from RETURNING, not meta.changes, which on D1 also
  // counts rows written by the posts_set_updated_at trigger.
  const [, released] = await database.batch<{ id: number }>([
    database
      .prepare(
        `INSERT INTO post_delivery_attempts (post_id, workflow_instance_id, lease_token, outcome, detail)
         SELECT id, workflow_instance_id, posting_lease_token, 'review_required', ?
           FROM posts
          WHERE id = ?
            AND status = 'posting'
            AND workflow_instance_id = ?
            AND posting_lease_token = ?`,
      )
      .bind(reason, claim.postId, claim.workflowInstanceId, claim.leaseToken),
    database
      .prepare(
        `UPDATE posts
            SET status = 'review_required',
                review_reason = ?,
                error_message = ?,
                posting_lease_token = NULL,
                posting_lease_expires_at = NULL,
                updated_at = unixepoch()
          WHERE id = ?
            AND status = 'posting'
            AND workflow_instance_id = ?
            AND posting_lease_token = ?
          RETURNING id`,
      )
      .bind(reason, reason, claim.postId, claim.workflowInstanceId, claim.leaseToken),
  ]);

  if (released.results.length !== 1) {
    throw new Error(`Lost delivery lease for post ${claim.postId}`);
  }
}

export async function releaseExpiredDeliveryLeases(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const result = await database
    .prepare(
      `UPDATE posts
          SET status = 'review_required',
              review_reason = 'Publishing lease expired; platform outcome is unknown and requires manual review.',
              error_message = 'Publishing lease expired; platform outcome is unknown and requires manual review.',
              posting_lease_token = NULL,
              posting_lease_expires_at = NULL,
              updated_at = ?
        WHERE status = 'posting'
          AND posting_lease_expires_at IS NOT NULL
          AND posting_lease_expires_at <= ?
        RETURNING id`,
    )
    .bind(now, now)
    .all<{ id: number }>();
  return result.results.length;
}

export { workflowInstanceId };
