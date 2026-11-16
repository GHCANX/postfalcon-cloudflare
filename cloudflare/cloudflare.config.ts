import { bindings, defineConfig, exports as workerExports, triggers } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * No account id, custom domain, or secret belongs in this file. `cf` reads the
 * account from its authenticated profile and receives secrets separately.
 */
export default defineConfig(({ mode }) => {
  const isStaging = mode !== "production";
  const suffix = isStaging ? "staging" : "production";

  return {
    worker: {
      name: `postfalcon-${suffix}`,
      entrypoint,
      compatibilityDate: "2026-11-16",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: true,
      previewUrls: true,
      assets: {
        notFoundHandling: "404-page",
        runWorkerFirst: ["/api/*", "/uploads/*", "/healthz"],
      },
      env: {
        APP_PROFILE: bindings.text("self-hosted-single-user"),
        DB: bindings.d1({
          name: `postfalcon-${suffix}`,
          ...(isStaging ? { id: "153ee2ab-906e-4dd9-a41c-52bfc4c8bbdc" } : {}),
        }),
        // Set with `cf workers secrets update`; see README "Secrets".
        SESSION_SECRET: bindings.secret(),
        SETUP_TOKEN: bindings.secret(),
        MEDIA: bindings.r2({ name: `postfalcon-${suffix}-media` }),
        R2_BUDGET: bindings.json({
          maxObjectBytes: 25 * 1024 * 1024,
          maxMediaBytes: 7 * 1024 * 1024 * 1024,
          maxTotalBytes: 8 * 1024 * 1024 * 1024,
          maxClassAOperationsPerMonth: 100_000,
          maxClassBOperationsPerMonth: 1_000_000,
        }),
      },
      triggers: [triggers.scheduled({ schedule: "* * * * *" })],
      exports: {
        ScheduledPostDelivery: workerExports.workflow({
          // Workflow definitions bind to a Worker code version at creation.
          // Advance this suffix deliberately when a Workflow code change must
          // take effect, retaining old definitions only until their instances
          // have drained or been explicitly inspected.
          name: `postfalcon-${suffix}-post-delivery-v8`,
          concurrency: { limit: 10 },
          limits: { steps: 24 },
          defaultRetention: {
            successRetention: "3 days",
            errorRetention: "3 days",
          },
        }),
      },
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, headSamplingRate: 1 },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
    },
  };
});
