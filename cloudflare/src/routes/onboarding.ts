import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { onboardingStatus } from "../lib/onboarding";

/** /api/onboarding: the dashboard checklist's data and dismissals. */
export const onboardingRoutes = new Hono<AppEnv>();
onboardingRoutes.use("*", requireAuth);

onboardingRoutes.get("/", async (context) => context.json(await onboardingStatus(context.env.DB, context.get("user").id)));

onboardingRoutes.post("/dismiss", async (context) => {
  await context.env.DB.prepare("UPDATE users SET onboarding_dismissed_at = unixepoch() WHERE id = ?").bind(context.get("user").id).run();
  return context.body(null, 204);
});

onboardingRoutes.post("/admin/dismiss", async (context) => {
  const user = context.get("user");
  if (!user.isAdmin) return context.json({ error: "not found" }, 404);
  await context.env.DB.prepare("UPDATE users SET admin_setup_dismissed_at = unixepoch() WHERE id = ?").bind(user.id).run();
  return context.body(null, 204);
});
