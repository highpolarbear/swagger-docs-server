// Swagger UI at /, spec at /openapi.yaml and /openapi.json, offline export at /export/docs.html
// (all behind Nextcloud sign-in),
// MCP endpoint at /mcp (behind its own token).
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import swaggerUiDist from "swagger-ui-dist";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SpecStore } from "./spec-store.js";
import { buildMcpServer } from "./mcp-tools.js";
import { setupAuth } from "./auth.js";
import { registerExportRoutes } from "./exports.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8080);
const SPEC_PATH = process.env.SPEC_PATH ?? path.join(root, "data", "openapi.yaml");
const MCP_TOKEN = process.env.MCP_TOKEN ?? "";

if (MCP_TOKEN.length < 24) {
  console.error("MCP_TOKEN must be set to a random string of at least 24 characters (e.g. `openssl rand -hex 32`).");
  process.exit(1);
}

const store = new SpecStore(SPEC_PATH);
await store.ensureExists(path.join(root, "starter", "openapi.yaml"));

const app = express();
app.disable("x-powered-by");

// Security headers on every response.
const HTTPS = (process.env.PUBLIC_URL ?? "").startsWith("https://");
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(HTTPS ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  });
  next();
});

// --- Public -------------------------------------------------------------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- MCP (token auth, registered before the session middleware) -----------
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Accepts `Authorization: Bearer <token>` or the token as a path segment (/mcp/<token>)
// for clients that can't send custom headers.
function requireMcpToken(req, res, next) {
  const header = req.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (safeEqual(bearer, MCP_TOKEN) || safeEqual(req.params.token ?? "", MCP_TOKEN)) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

const mcpPaths = ["/mcp", "/mcp/:token"];

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post(mcpPaths, requireMcpToken, express.json({ limit: "2mb" }), async (req, res) => {
  const server = buildMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.all(mcpPaths, requireMcpToken, (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

// --- Docs (Nextcloud sign-in) ---------------------------------------------
const { requireLogin } = await setupAuth(app);
app.use(requireLogin);

// Everything below is for signed-in users only. Mark it private so Cloudflare (which caches .js
// and .css by default) or any other shared cache never stores it and serves it to someone else.
app.use((_req, res, next) => {
  res.set("Cache-Control", "private, no-cache");
  next();
});

registerExportRoutes(app, store);
// Serve only the two Swagger UI files the page uses, not the whole package
// (which includes a demo page that loads the public Petstore example).
const uiDir = swaggerUiDist.getAbsoluteFSPath();
for (const file of ["swagger-ui.css", "swagger-ui-bundle.js"]) {
  app.get(`/swagger-ui/${file}`, (_req, res) => res.sendFile(path.join(uiDir, file), { cacheControl: false }));
}
app.use(express.static(path.join(root, "public"), { cacheControl: false }));

app.use((req, res) => res.status(404).type("text").send("Not found"));

// Never send error details or stack traces to the client; they go to the log only.
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).type("text").send(status === 500 ? "Internal server error" : "Bad request");
});

app.listen(PORT, () => {
  console.log(`Swagger docs:  http://localhost:${PORT}/`);
  console.log(`MCP endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`Spec file:     ${SPEC_PATH}`);
});
