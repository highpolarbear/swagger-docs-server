// Login for the docs pages through Nextcloud.
//
// AUTH_MODE=oidc              Nextcloud with the "OIDC Identity Provider" app (recommended).
// AUTH_MODE=nextcloud-oauth2  Nextcloud's built-in OAuth 2.0 (no app needed). The access token
//                             it issues can reach the whole account, so it is used once to read
//                             the user's identity and is never stored.
// AUTH_MODE=none              No login. Only for local development.
import crypto from "node:crypto";
import cookieSession from "cookie-session";
import * as oidc from "openid-client";

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();
const list = (name) => env(name).split(",").map((s) => s.trim()).filter(Boolean);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function die(message) {
  console.error(`Auth configuration error: ${message}`);
  process.exit(1);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(res, status, title, body) {
  res
    .status(status)
    .type("html")
    .send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f2328}a{color:#0969da}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
}

// Only allow redirects back to a path on this site. The URL parser treats a backslash as "/" just
// like browsers do, which catches tricks such as "/\evil.com" that a browser reads as "//evil.com".
function safeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\\u0000-\u001f]/.test(value)) return "/";
  try {
    const url = new URL(value, "http://same-origin.invalid");
    if (url.origin !== "http://same-origin.invalid") return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

export async function setupAuth(app) {
  const mode = env("AUTH_MODE", "oidc");
  const specReadToken = env("SPEC_READ_TOKEN");
  if (specReadToken && specReadToken.length < 24) die("SPEC_READ_TOKEN must be at least 24 characters.");

  if (mode === "none") {
    console.warn("WARNING: AUTH_MODE=none. Anyone who can reach this server can read the docs.");
    return { requireLogin: (_req, _res, next) => next() };
  }
  if (!["oidc", "nextcloud-oauth2"].includes(mode)) die(`Unknown AUTH_MODE "${mode}".`);

  // ---- Configuration ----------------------------------------------------------
  const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "");
  const nextcloudUrl = env("NEXTCLOUD_URL").replace(/\/+$/, "");
  const clientId = env("OAUTH_CLIENT_ID");
  const clientSecret = env("OAUTH_CLIENT_SECRET");
  const sessionSecret = env("SESSION_SECRET");
  const sessionHours = Number(env("SESSION_HOURS", "12"));
  const allowedUsers = list("ALLOWED_USERS");
  const allowedGroups = list("ALLOWED_GROUPS");

  if (!/^https?:\/\//.test(publicUrl)) die("PUBLIC_URL must be the address users open, e.g. https://docs.example.com");
  if (!/^https?:\/\//.test(nextcloudUrl)) die("NEXTCLOUD_URL must be your Nextcloud address, e.g. https://cloud.example.com");
  if (!clientId || !clientSecret) die("OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are required.");
  if (sessionSecret.length < 32) die("SESSION_SECRET must be at least 32 characters (openssl rand -hex 32).");
  if (!(sessionHours > 0)) die("SESSION_HOURS must be a positive number.");
  if (!allowedUsers.length && !allowedGroups.length) {
    console.warn("WARNING: ALLOWED_USERS and ALLOWED_GROUPS are empty, so every Nextcloud user can read the docs.");
  }

  const secure = publicUrl.startsWith("https://");
  if (!secure) console.warn("WARNING: PUBLIC_URL is not HTTPS. Use plain HTTP only for local testing.");
  const redirectUri = `${publicUrl}/auth/callback`;

  // ---- Provider-specific login ------------------------------------------------
  let provider;
  if (mode === "oidc") {
    const issuer = env("OIDC_ISSUER", nextcloudUrl);
    const scope = env("OIDC_SCOPES", "openid profile email");
    const insecure = issuer.startsWith("http://");
    let config;
    try {
      config = await oidc.discovery(
        new URL(issuer),
        clientId,
        clientSecret,
        undefined,
        insecure ? { execute: [oidc.allowInsecureRequests] } : undefined
      );
    } catch (e) {
      die(`OIDC discovery failed for ${issuer} (${e.message}). Is the OIDC Identity Provider app installed? ` +
        `If your Nextcloud URLs contain /index.php, try OIDC_ISSUER=${issuer}/index.php`);
    }
    if (insecure) oidc.allowInsecureRequests(config);

    provider = {
      async start(pending) {
        pending.verifier = oidc.randomPKCECodeVerifier();
        pending.nonce = oidc.randomNonce();
        return oidc.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope,
          state: pending.state,
          nonce: pending.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
          code_challenge_method: "S256",
        }).href;
      },
      async finish(req, pending) {
        const tokens = await oidc.authorizationCodeGrant(config, new URL(req.originalUrl, publicUrl), {
          pkceCodeVerifier: pending.verifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
        let claims = tokens.claims();
        try {
          claims = { ...claims, ...(await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)) };
        } catch {
          // Userinfo is optional; the ID token is enough.
        }
        const groups = Array.isArray(claims.groups) ? claims.groups : null;
        return {
          id: String(claims.preferred_username ?? claims.sub),
          name: String(claims.name ?? claims.preferred_username ?? claims.sub),
          email: claims.email ?? null,
          groups,
        };
      },
    };
  } else {
    const authorizeUrl = `${nextcloudUrl}/index.php/apps/oauth2/authorize`;
    const tokenUrl = `${nextcloudUrl}/index.php/apps/oauth2/api/v1/token`;
    const userUrl = `${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`;

    provider = {
      async start(pending) {
        const url = new URL(authorizeUrl);
        url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state: pending.state });
        return url.href;
      },
      async finish(req, pending) {
        if (!req.query.state || !safeEqual(req.query.state, pending.state)) throw new Error("State mismatch");
        if (!req.query.code) throw new Error(`No authorization code (${req.query.error ?? "unknown error"})`);
        const tokenRes = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: String(req.query.code),
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        if (!tokenRes.ok) throw new Error(`Token request failed with HTTP ${tokenRes.status}`);
        const { access_token: accessToken } = await tokenRes.json();
        if (!accessToken) throw new Error("No access token in response");

        const userRes = await fetch(userUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, "OCS-APIRequest": "true", Accept: "application/json" },
        });
        if (!userRes.ok) throw new Error(`User lookup failed with HTTP ${userRes.status}`);
        const data = (await userRes.json())?.ocs?.data;
        if (!data?.id) throw new Error("User lookup returned no user id");
        // The access token goes out of scope here and is never stored.
        return {
          id: String(data.id),
          name: String(data.displayname ?? data["display-name"] ?? data.id),
          email: data.email ?? null,
          groups: Array.isArray(data.groups) ? data.groups : null,
        };
      },
    };
  }

  function isAllowed(user) {
    if (!allowedUsers.length && !allowedGroups.length) return true;
    if (allowedUsers.includes(user.id)) return true;
    return (user.groups ?? []).some((g) => allowedGroups.includes(g));
  }

  // ---- Session (signed cookie, nothing stored server-side) --------------------
  app.set("trust proxy", env("TRUST_PROXY", "loopback, linklocal, uniquelocal"));

  // Behind Cloudflare Tunnel or another TLS-terminating proxy, the last hop to this container is
  // plain HTTP and the proxy reports the original protocol in X-Forwarded-Proto. If that header is
  // missing on a request from a trusted proxy while PUBLIC_URL is HTTPS, assume HTTPS so the
  // Secure login cookie can still be set. Requests from untrusted addresses are left alone.
  if (secure) {
    const trusted = app.get("trust proxy fn");
    app.use((req, _res, next) => {
      if (!req.headers["x-forwarded-proto"] && trusted(req.socket.remoteAddress, 0)) {
        req.headers["x-forwarded-proto"] = "https";
      }
      next();
    });
  }

  // Sign-in responses must never be cached by a proxy or CDN.
  app.use("/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(
    cookieSession({
      name: "docs_session",
      keys: [sessionSecret],
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: sessionHours * 3600 * 1000,
    })
  );

  const currentUser = (req) => {
    const u = req.session?.user;
    return u && u.exp > Date.now() ? u : null;
  };

  // ---- Routes -----------------------------------------------------------------
  app.get("/auth/login", async (req, res, next) => {
    try {
      const pending = { state: oidc.randomState(), returnTo: safeReturnTo(req.query.returnTo), started: Date.now() };
      const url = await provider.start(pending);
      req.session.pending = pending;
      res.redirect(url);
    } catch (e) {
      next(e);
    }
  });

  app.get("/auth/callback", async (req, res) => {
    const pending = req.session?.pending;
    req.session.pending = null;
    if (!pending || Date.now() - pending.started > 10 * 60 * 1000) {
      return page(res, 400, "Sign-in expired", `<p>That sign-in attempt expired. <a href="/auth/login">Try again</a>.</p>`);
    }
    let user;
    try {
      user = await provider.finish(req, pending);
    } catch (e) {
      console.error("Sign-in failed:", e.message);
      return page(res, 400, "Sign-in failed", `<p>Nextcloud sign-in did not complete. <a href="/auth/login">Try again</a>.</p>`);
    }
    if (allowedGroups.length && user.groups === null) {
      console.warn(`Sign-in for ${user.id}: Nextcloud sent no group information, so ALLOWED_GROUPS can't be checked.` +
        (mode === "oidc" ? " Add the groups scope to OIDC_SCOPES if your OIDC app supports it." : ""));
    }
    if (!isAllowed(user)) {
      console.warn(`Sign-in refused for Nextcloud user ${user.id} (not in ALLOWED_USERS or ALLOWED_GROUPS).`);
      req.session = null;
      return page(res, 403, "Access denied",
        `<p>You signed in as <strong>${escapeHtml(user.id)}</strong>, but that account isn't allowed to view these docs. Ask an administrator for access.</p>`);
    }
    console.log(`Signed in: ${user.id}`);
    req.session.user = { id: user.id, name: user.name, exp: Date.now() + sessionHours * 3600 * 1000 };
    res.redirect(pending.returnTo);
  });

  app.get("/auth/logout", (req, res) => {
    req.session = null;
    page(res, 200, "Signed out", `<p>You have been signed out of the API docs. <a href="/auth/login">Sign in again</a>.</p>`);
  });

  app.get("/auth/me", (req, res) => {
    const u = currentUser(req);
    u ? res.json({ id: u.id, name: u.name }) : res.status(401).json({ error: "Not signed in" });
  });

  // ---- Gate for everything registered after this ------------------------------
  function requireLogin(req, res, next) {
    if (currentUser(req)) return next();

    // Lets a CI build fetch the spec without a browser login.
    if (specReadToken && ["/openapi.yaml", "/openapi.json"].includes(req.path)) {
      const header = req.get("authorization") ?? "";
      if (header.startsWith("Bearer ") && safeEqual(header.slice(7), specReadToken)) return next();
    }

    // Not signed in. Never let a CDN cache this answer (Cloudflare caches redirects for .js files by default).
    res.set("Cache-Control", "no-store");

    // Browsers get sent to sign-in; API clients (or anything sending credentials) get a plain 401.
    if (req.method === "GET" && !req.get("authorization") && req.accepts(["html", "json"]) === "html") {
      return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    res.status(401).json({ error: "Sign in required" });
  }

  console.log(`Docs sign-in: Nextcloud (${mode}), redirect URI ${redirectUri}`);
  return { requireLogin };
}
