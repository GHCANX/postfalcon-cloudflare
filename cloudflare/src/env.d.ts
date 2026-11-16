// Optional operator-set secrets. They are deliberately not declared in
// cloudflare.config.ts: a declared secret is required at deploy time, and the
// instance must run (without email) before Mailgun is set up. Set them with
// `cf workers secrets update <NAME> --worker <worker> --type secret_text --text <value>`;
// a secret set that way survives later deploys.
interface Env {
  /** Mailgun private API key (or a domain sending key). */
  MAILGUN_API_KEY?: string;
  /** Sending domain, e.g. mg.example.com. */
  MAILGUN_DOMAIN?: string;
  /** From header, e.g. "Postfalcon <postfalcon@mg.example.com>". */
  MAILGUN_FROM?: string;
  /** "eu" for Mailgun's EU region; anything else uses the US API. */
  MAILGUN_REGION?: string;
  /** Meta (Facebook Login) app id and secret: needed to connect Instagram. */
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  /** Login configuration id, for a Business-type Meta app (used instead of a scope list). */
  FACEBOOK_CONFIG_ID?: string;
  /** TikTok app (Login Kit + Content Posting API) client key and secret. */
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  /** Public origin of this Worker, e.g. https://example.com. Instagram fetches media from `<origin>/uploads/...`. */
  PUBLIC_BASE_URL?: string;
}
