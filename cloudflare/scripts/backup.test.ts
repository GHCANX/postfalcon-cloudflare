// Stubbed-fetch checks for lib/backup.ts. Run:
//   npx esbuild scripts/backup.test.ts --bundle --platform=node --format=esm --outfile=<out>.mjs && node <out>.mjs
import { backupConfigured, pollExport, startExport } from "../src/lib/backup";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};

const ENV = { CLOUDFLARE_API_TOKEN: "tok-secret", CLOUDFLARE_ACCOUNT_ID: "acct", D1_DATABASE_ID: "db" } as unknown as Env;
const calls: { url: string; auth: string | null; body: unknown }[] = [];
let reply: () => Response = () => new Response("{}");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
  return reply();
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

check("configured needs all three", backupConfigured(ENV) && !backupConfigured({ ...ENV, D1_DATABASE_ID: undefined } as unknown as Env) && !backupConfigured({ ...ENV, CLOUDFLARE_API_TOKEN: "change-me" } as unknown as Env));

reply = () => json({ success: true, result: { at_bookmark: "bm-1", status: "active" } });
const started = await startExport(ENV);
check("start returns the bookmark and no url yet", started.bookmark === "bm-1" && started.signedUrl === null);
check("start posts polling format to the database's export endpoint with a bearer token",
  calls[0].url === "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/export" && calls[0].auth === "Bearer tok-secret" && (calls[0].body as { output_format: string }).output_format === "polling");

reply = () => json({ success: true, result: { status: "active" } });
check("poll returns null while the export runs", (await pollExport(ENV, "bm-1")) === null);
check("poll sends the bookmark", (calls[1].body as { current_bookmark: string }).current_bookmark === "bm-1");

reply = () => json({ success: true, result: { status: "complete", signed_url: "https://r2.example/dump.sql" } });
check("poll returns the flat signed url", (await pollExport(ENV, "bm-1")) === "https://r2.example/dump.sql");
reply = () => json({ success: true, result: { at_bookmark: "bm-2", status: "complete", type: "export", result: { filename: "f.sql", signed_url: "https://r2.example/nested.sql" } } });
check("poll reads the nested url the live API returns", (await pollExport(ENV, "bm-2")) === "https://r2.example/nested.sql");
const instant = await startExport(ENV);
check("start returns the url when the export is already complete", instant.signedUrl === "https://r2.example/nested.sql" && instant.bookmark === "bm-2");

reply = () => json({ success: true, result: { status: "error", error: "boom" } });
check("poll surfaces an export error", await pollExport(ENV, "bm-1").then(() => false, (e: Error) => e.message.includes("boom")));

reply = () => json({ success: false, errors: [{ message: "Authentication error" }] }, 403);
const denied = await startExport(ENV).then(() => "", (e: Error) => e.message);
check("API errors name the status and message but never the token", denied.includes("403") && denied.includes("Authentication error") && !denied.includes("tok-secret"), denied);

reply = () => json({ success: true, result: {} });
check("start without a bookmark fails", await startExport(ENV).then(() => false, () => true));

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
