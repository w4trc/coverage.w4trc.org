import { log } from "./util";

/** Server-side Turnstile verification. Fails closed. */
export async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!secret) {
    log("error", "TURNSTILE_SECRET_KEY is not set; rejecting submission");
    return false;
  }
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) log("warn", "turnstile failed", { codes: data["error-codes"] });
    return data.success === true;
  } catch (err) {
    log("error", "turnstile request failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
