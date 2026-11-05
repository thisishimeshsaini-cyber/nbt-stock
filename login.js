import { subscribeMember, getMemberState, login, register, verifyEmail } from "/js/wix/member-store.js";

const $ = (id) => document.getElementById(id);
const rt = new URLSearchParams(location.search).get("returnTo") || "/index.html";
const safe = rt.charAt(0) === "/" && rt.charAt(1) !== "/" ? rt : "/index.html";
const panes = [$("fIn"), $("fUp"), $("fCode"), $("approval")];
function showOnly(el) { panes.forEach((p) => { p.hidden = p !== el; }); }
function tab(which) { $("tIn").setAttribute("aria-pressed", String(which === "in")); $("tUp").setAttribute("aria-pressed", String(which === "up")); showOnly(which === "in" ? $("fIn") : $("fUp")); }
$("tIn").onclick = () => tab("in");
$("tUp").onclick = () => tab("up");
const MSG = {
  invalidPassword: "That password doesn't match. Try again.",
  invalidEmail: "We couldn't find an account with that email. Tap Sign up to create one.",
  emailAlreadyExists: "There's already an account with that email. Log in instead.",
  resetPassword: "This account needs a new password. Contact the admin."
};
function show(r, form) {
  if (r.state === "SUCCESS") { location.assign(safe); return; }
  if (r.state === "EMAIL_VERIFICATION_REQUIRED") { showOnly($("fCode")); return; }
  if (r.state === "OWNER_APPROVAL_REQUIRED") { showOnly($("approval")); return; }
  form.querySelector("[data-err]").textContent = MSG[r.errorCode] || r.error || "That didn't work. Check the details and try again.";
}
function bind(form, action) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const b = form.querySelector("button[type=submit]"); b.disabled = true;
    form.querySelector("[data-err]").textContent = "";
    action(form.elements).then((r) => show(r, form))
      .catch((err) => show({ state: "FAILURE", error: err && err.message ? err.message : String(err) }, form))
      .then(() => { b.disabled = false; });
  });
}
bind($("fIn"), (f) => login(f.email.value.trim(), f.password.value));
bind($("fUp"), (f) => register(f.email.value.trim(), f.password.value, { firstName: f.firstName.value.trim(), lastName: f.lastName.value.trim() }));
bind($("fCode"), (f) => verifyEmail(f.code.value.trim()));
subscribeMember((s) => { if (!s.loading && s.loggedIn) location.replace(safe); });
const s0 = getMemberState(); if (!s0.loading && s0.loggedIn) location.replace(safe);
