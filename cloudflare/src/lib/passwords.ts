import { base64Url, fromBase64Url, randomBytes, timingSafeEqualBytes } from "./crypto";

// New hashes use PBKDF2 from Web Crypto: it runs natively, which matters under
// the Workers Free CPU limit, and 100,000 is the most iterations the Workers
// runtime accepts. Stored as `pbkdf2-sha256$<iterations>$<salt>$<hash>`.
const SCHEME = "pbkdf2-sha256";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, ITERATIONS);
  return `${SCHEME}$${ITERATIONS}$${base64Url(salt)}$${base64Url(hash)}`;
}

export type PasswordCheck = {
  ok: boolean;
  /** True when the stored hash should be replaced with a current-format one. */
  needsRehash: boolean;
};

/**
 * Checks a password against a stored hash. Accepts this runtime's PBKDF2
 * format and the bcrypt hashes the Docker app writes, so an imported account
 * can sign in; the caller re-hashes a bcrypt match to PBKDF2.
 */
export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (stored.startsWith(`${SCHEME}$`)) {
    const [, iterationText, saltText, hashText] = stored.split("$");
    const iterations = Number(iterationText);
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > ITERATIONS || !saltText || !hashText) {
      return { ok: false, needsRehash: false };
    }
    const expected = fromBase64Url(hashText);
    const actual = await derive(password, fromBase64Url(saltText), iterations);
    const ok = timingSafeEqualBytes(expected, actual);
    return { ok, needsRehash: ok && iterations < ITERATIONS };
  }

  if (/^\$2[aby]\$/.test(stored)) {
    const { compare } = await import("bcryptjs");
    const ok = await compare(password, stored);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

/** Spends the same work as a real check, for sign-ins to an unknown email. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, new Uint8Array(SALT_BYTES), ITERATIONS);
}
