// Kept in its own file so the page can run under a strict Content-Security-Policy (no inline scripts).
window.ui = SwaggerUIBundle({
  url: "/openapi.yaml",
  dom_id: "#swagger-ui",
  deepLinking: true,
  tryItOutEnabled: false,
  validatorUrl: null // don't send the spec's address to validator.swagger.io
});

fetch("/auth/me", { credentials: "same-origin" })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (me) {
    if (!me) return;
    document.getElementById("account-name").textContent = me.name;
    document.getElementById("account").hidden = false;
  })
  .catch(function () {});
