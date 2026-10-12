// dsh-restart-anywhere — browser half: a small ↻ "Restart dsh" row above Settings
// in the left sidebar (icon only when the sidebar is collapsed to its rail).
// Hidden only where restart isn't supported (desktop app). Click -> confirm ->
// POST, then poll until a server with a new boot id answers, then reload.
window.__ModuleLoader__.load({ id: "dsh-restart-anywhere", factory: (require) => {
  var module = { exports: {} };
  const react = require("react");
  const h = react.createElement;
  const ROUTE = "api/dsh-restart"; // relative: works under a path prefix too

  const base = {
    height: 32, border: "none", borderRadius: 8, background: "transparent", font: "inherit", fontSize: 14,
    color: "var(--dsw-alias-label-secondary, currentColor)", display: "flex",
    alignItems: "center", gap: 8, cursor: "pointer"
  };
  const wideStyle = Object.assign({}, base, { width: "100%", padding: "0 10px" });
  const railStyle = Object.assign({}, base, { width: 32, padding: 0, justifyContent: "center", margin: "0 auto" });

  function Icon(props) {
    return h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
      style: props.spin ? { animation: "dsh-sr-spin 1s linear infinite" } : undefined },
      h("style", null, "@keyframes dsh-sr-spin{to{transform:rotate(360deg)}}"),
      h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }), h("path", { d: "M21 3v6h-6" }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const info = () => fetch(ROUTE, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null), () => null);

  /** Wait until a server with a different boot id answers: robust however fast the restart is. */
  async function waitForNewBoot(oldBoot) {
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const b = await info();
      if (b && b.boot && b.boot !== oldBoot) return true;
    }
    return false;
  }

  function RestartButton(props) {
    const [how, setHow] = react.useState(null);
    const [phase, setPhase] = react.useState("idle");
    react.useEffect(() => {
      info().then(setHow);
    }, []);
    if (!how || !how.mode) return null;

    const onClick = async () => {
      if (phase === "busy") return;
      const via = how.mode === "systemd" ? "systemd (" + how.unit + ")" : "an in-place restart";
      if (!window.confirm("Restart dsh via " + via + "?\nRunning sessions will be interrupted.")) return;
      setPhase("busy");
      try {
        const res = await fetch(ROUTE, { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
        if (await waitForNewBoot(how.boot)) return window.location.reload();
        throw new Error("dsh did not come back within 2 minutes");
      } catch (e) {
        setPhase("idle");
        window.alert("Restart failed: " + (e && e.message ? e.message : e));
      }
    };

    const label = phase === "busy" ? "Restarting dsh…" : "Restart dsh";
    return h("button", { type: "button", style: props.wide ? wideStyle : railStyle, title: label, "aria-label": label,
      disabled: phase === "busy", onClick,
      onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"; },
      onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; } },
      h(Icon, { spin: phase === "busy" }), props.wide ? h("span", null, label) : null);
  }

  module.exports.inject = ["slots"];
  module.exports.apply = function (ctx) {
    ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-restart-anywhere", order: 10 }, RestartButton)),
      "dsh-restart-anywhere: sidebar button");
  };
  return module.exports;
} });
