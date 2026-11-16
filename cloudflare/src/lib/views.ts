import { TEMPLATES } from "../views/generated";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };

/** Same escaping as EJS's `<%= %>`. */
function escapeXML(value: unknown): string {
  return value == null ? "" : String(value).replace(/[&<>'"]/g, (char) => ESCAPES[char]!);
}

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/** Resolves an `include('x')` written inside template `from` the way EJS does. */
function resolve(from: string, reference: string): string {
  const directory = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const relative = `${directory}${reference}`;
  if (relative in TEMPLATES) return relative;
  if (reference in TEMPLATES) return reference;
  throw new Error(`Unknown template include '${reference}' from '${from}'`);
}

function run(name: string, locals: Record<string, unknown>): string {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown template '${name}'`);
  const include = (reference: string, data?: object) => run(resolve(name, reference), { ...locals, ...data });
  return template(locals, escapeXML, include, rethrow);
}

/** Renders a precompiled view. Locals missing from the view's own set read as undefined, never throw. */
export function renderView(name: string, locals: Record<string, unknown>): string {
  return run(name, locals);
}
