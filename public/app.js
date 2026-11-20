// Kept in its own file so the page can run under a strict Content-Security-Policy (no inline scripts).
window.ui = SwaggerUIBundle({
  url: "/openapi.yaml",
  dom_id: "#swagger-ui",
  deepLinking: true,
  tryItOutEnabled: false,
  validatorUrl: null // don't send the spec's address to validator.swagger.io
});

// Shows who is signed in: from this server's own sign-in, or from Pomerium when AUTH_MODE=none.
fetch("/auth/me", { credentials: "same-origin" })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (me) {
    if (!me) return;
    document.getElementById("account-name").textContent = me.name;
    if (me.logoutUrl) document.getElementById("account-logout").href = me.logoutUrl;
    document.getElementById("account").hidden = false;
  })
  .catch(function () {});
