import {
  R2BudgetExceededError,
  releaseR2StorageReservation,
  reserveR2Budget,
  type R2Budget,
} from "./r2-budget";

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

function parseContentLength(request: Request): number {
  const value = request.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) {
    throw new UploadRejectedError("A valid Content-Length header is required for uploads");
  }

  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new UploadRejectedError("Upload size must be a positive integer");
  }
  return bytes;
}

function cappedBody(body: ReadableStream<Uint8Array>, maximumBytes: number, declaredBytes: number): {
  body: ReadableStream<Uint8Array>;
  bytesReceived: () => number;
} {
  let received = 0;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximumBytes) {
        controller.error(new UploadRejectedError("Upload exceeds the configured 25 MB limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  // R2 needs a stream of known length; FixedLengthStream also errors when the
  // body is shorter or longer than the declared Content-Length.
  return { body: body.pipeThrough(stream).pipeThrough(new FixedLengthStream(declaredBytes)), bytesReceived: () => received };
}

export type MediaUpload = {
  key: string;
  contentType: string;
};

/**
 * Keeps the upload on the Worker path. The caller must authenticate and choose
 * a namespaced, server-generated key before calling this function.
 */
export async function storeBoundedMedia(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  budget: R2Budget,
  upload: MediaUpload,
): Promise<{ byteSize: number }> {
  if (!request.body) {
    throw new UploadRejectedError("An upload body is required");
  }

  const declaredBytes = parseContentLength(request);
  if (declaredBytes > budget.maxObjectBytes) {
    throw new R2BudgetExceededError("object");
  }

  // Reserve before the R2 call. A failed put may still consume an operation,
  // but it cannot consume storage once no object exists.
  await reserveR2Budget(database, budget, {
    classAOperations: 1,
    mediaBytes: declaredBytes,
    totalBytes: declaredBytes,
  });

  const capped = cappedBody(request.body, budget.maxObjectBytes, declaredBytes);
  try {
    await bucket.put(upload.key, capped.body, {
      httpMetadata: { contentType: upload.contentType },
    });
  } catch (error) {
    await releaseR2StorageReservation(database, {
      mediaBytes: declaredBytes,
      totalBytes: declaredBytes,
    });
    if (capped.bytesReceived() !== declaredBytes && !(error instanceof UploadRejectedError)) {
      throw new UploadRejectedError("Upload body length did not match Content-Length");
    }
    throw error;
  }

  if (capped.bytesReceived() !== declaredBytes) {
    // Do not silently trust a malformed request. The delete is also charged and
    // must be recorded before it occurs. Storage is released only after the
    // delete succeeds; both R2 operations remain conservatively charged.
    await reserveR2Budget(database, budget, { classAOperations: 1 });
    await bucket.delete(upload.key);
    await releaseR2StorageReservation(database, {
      mediaBytes: declaredBytes,
      totalBytes: declaredBytes,
    });
    throw new UploadRejectedError("Upload body length did not match Content-Length");
  }

  return { byteSize: declaredBytes };
}
