// Download routes: the spec as YAML or JSON, and a single-file offline copy of the docs.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import swaggerUiDist from "swagger-ui-dist";

const uiDir = swaggerUiDist.getAbsoluteFSPath();
let uiAssets; // loaded once, on first offline export
const loadUiAssets = async () =>
  (uiAssets ??= {
    css: await fs.readFile(path.join(uiDir, "swagger-ui.css"), "utf8"),
    js: await fs.readFile(path.join(uiDir, "swagger-ui-bundle.js"), "utf8"),
  });

// "My API" + "0.1.0" -> "my-api-0.1.0"
function baseName(spec) {
  const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  return [slug(spec?.info?.title) || "openapi", slug(spec?.info?.version)].filter(Boolean).join("-");
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// JSON that is safe to place inside a <script> element
const scriptSafeJson = (v) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function registerExportRoutes(app, store) {
  const send = (res, type, body, filename, download) => {
    res.set("Cache-Control", "private, no-store").type(type);
    if (download) res.attachment(filename);
    res.send(body);
  };

  app.get("/openapi.yaml", async (req, res, next) => {
    try {
      const text = await store.readText();
      send(res, "application/yaml", text, `${baseName(YAML.parse(text))}.yaml`, "download" in req.query);
    } catch (e) {
      next(e);
    }
  });

  app.get("/openapi.json", async (req, res, next) => {
    try {
      const spec = await store.loadObject();
      send(res, "application/json", JSON.stringify(spec, null, 2), `${baseName(spec)}.json`, "download" in req.query);
    } catch (e) {
      next(e);
    }
  });

  // Self-contained Swagger UI page with the spec embedded. Opens offline, from a file, without sign-in.
  app.get("/export/docs.html", async (_req, res, next) => {
    try {
      const spec = await store.loadObject();
      const { css, js } = await loadUiAssets();
      const title = `${spec.info?.title ?? "API"} ${spec.info?.version ?? ""}`.trim();
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>body{margin:0}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script>${js}</script>
<script>
SwaggerUIBundle({ spec: ${scriptSafeJson(spec)}, dom_id: "#swagger-ui", deepLinking: true, tryItOutEnabled: false, validatorUrl: null });
</script>
</body>
</html>`;
      // A download, never rendered by this site: sandbox it in case a browser displays it anyway.
      res.set("Content-Security-Policy", "sandbox");
      send(res, "text/html", html, `${baseName(spec)}-docs.html`, true);
    } catch (e) {
      next(e);
    }
  });
}
