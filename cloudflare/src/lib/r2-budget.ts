export type R2Budget = {
  /** Largest single object (a chunked upload may reach this). */
  maxObjectBytes: number;
  /** Largest object accepted in one request body. */
  maxDirectUploadBytes: number;
  maxMediaBytes: number;
  maxTotalBytes: number;
  maxClassAOperationsPerMonth: number;
  maxClassBOperationsPerMonth: number;
};

export type R2Reservation = {
  classAOperations?: number;
  classBOperations?: number;
  mediaBytes?: number;
  totalBytes?: number;
};

export class R2BudgetExceededError extends Error {
  constructor(readonly dimension: "object" | "class_a" | "class_b" | "media" | "total") {
    super(`R2 ${dimension} budget is exhausted`);
    this.name = "R2BudgetExceededError";
  }
}

function nonNegativeInteger(value: number | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return resolved;
}

export function utcMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Reserve before issuing an R2 operation. A provider-side failure may still
 * consume an operation, so only confirmed object storage is later released.
 */
export async function reserveR2Budget(
  database: D1Database,
  budget: R2Budget,
  reservation: R2Reservation,
  now = new Date(),
): Promise<void> {
  const classAOperations = nonNegativeInteger(reservation.classAOperations, "classAOperations");
  const classBOperations = nonNegativeInteger(reservation.classBOperations, "classBOperations");
  const mediaBytes = nonNegativeInteger(reservation.mediaBytes, "mediaBytes");
  const totalBytes = nonNegativeInteger(reservation.totalBytes, "totalBytes");

  if (mediaBytes > budget.maxObjectBytes) {
    throw new R2BudgetExceededError("object");
  }
  if (classAOperations > budget.maxClassAOperationsPerMonth) {
    throw new R2BudgetExceededError("class_a");
  }
  if (classBOperations > budget.maxClassBOperationsPerMonth) {
    throw new R2BudgetExceededError("class_b");
  }
  if (mediaBytes > budget.maxMediaBytes) {
    throw new R2BudgetExceededError("media");
  }
  if (totalBytes > budget.maxTotalBytes) {
    throw new R2BudgetExceededError("total");
  }

  const periodKey = utcMonthKey(now);
  const result = await database
    .prepare(
      `UPDATE r2_budget_state
          SET period_key = ?,
              class_a_operations = CASE WHEN period_key = ? THEN class_a_operations + ? ELSE ? END,
              class_b_operations = CASE WHEN period_key = ? THEN class_b_operations + ? ELSE ? END,
              media_bytes = media_bytes + ?,
              total_bytes = total_bytes + ?,
              updated_at = unixepoch()
        WHERE singleton = 1
          AND (period_key != ? OR class_a_operations + ? <= ?)
          AND (period_key != ? OR class_b_operations + ? <= ?)
          AND media_bytes + ? <= ?
          AND total_bytes + ? <= ?`,
    )
    .bind(
      periodKey,
      periodKey,
      classAOperations,
      classAOperations,
      periodKey,
      classBOperations,
      classBOperations,
      mediaBytes,
      totalBytes,
      periodKey,
      classAOperations,
      budget.maxClassAOperationsPerMonth,
      periodKey,
      classBOperations,
      budget.maxClassBOperationsPerMonth,
      mediaBytes,
      budget.maxMediaBytes,
      totalBytes,
      budget.maxTotalBytes,
    )
    .run();

  if (result.meta.changes !== 1) {
    // Do not reveal a precise remaining quota to callers. Admin usage views can
    // retrieve it separately; upload callers only need a safe refusal.
    throw new R2BudgetExceededError(
      classAOperations > 0 ? "class_a" : classBOperations > 0 ? "class_b" : mediaBytes > 0 ? "media" : "total",
    );
  }
}

/** Release only storage that has been confirmed removed from R2. */
export async function releaseR2StorageReservation(
  database: D1Database,
  reservation: Pick<R2Reservation, "mediaBytes" | "totalBytes">,
): Promise<void> {
  const mediaBytes = nonNegativeInteger(reservation.mediaBytes, "mediaBytes");
  const totalBytes = nonNegativeInteger(reservation.totalBytes, "totalBytes");
  const result = await database
    .prepare(
      `UPDATE r2_budget_state
          SET media_bytes = media_bytes - ?,
              total_bytes = total_bytes - ?,
              updated_at = unixepoch()
        WHERE singleton = 1
          AND media_bytes >= ?
          AND total_bytes >= ?`,
    )
    .bind(mediaBytes, totalBytes, mediaBytes, totalBytes)
    .run();

  if (result.meta.changes !== 1) {
    throw new Error("R2 storage accounting is inconsistent; uploads must remain paused");
  }
}
