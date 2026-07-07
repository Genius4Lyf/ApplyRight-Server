const { puppeteer, getLaunchOptions } = require("./browser");
const path = require("path");
const fs = require("fs");

// Read logo and convert to base64 data URI
const logoPath = path.join(__dirname, "..", "..", "public", "applyright-icon.png");
let LOGO_DATA_URI = "";
try {
  const logoBuffer = fs.readFileSync(logoPath);
  LOGO_DATA_URI = `data:image/png;base64,${logoBuffer.toString("base64")}`;
} catch {
  console.warn("[ScreenshotService] Logo not found at", logoPath);
}

/* ── helpers (same logic as frontend AdReportTemplate.jsx) ── */

const fmt = (value) => {
  const amount = Number(value) || 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}K`;
  return amount.toLocaleString();
};

const pct = (part, total) => {
  if (!total) return 0;
  return Math.round((part / total) * 100);
};

// Job-search analytics are not rendered on the platform, so reports are built
// entirely from CV / platform metrics (users, resumes, analyses, downloads, applications).
const getReportData = (stats = {}) => {
  const users = stats.totalUsers || 0;
  const resumes = stats.totalResumes || 0;
  const applications = stats.totalApplications || 0;
  const downloads = stats.featureUsage?.cvGeneration?.downloads || 0;
  const optimizations = stats.featureUsage?.cvGeneration?.optimizations || 0;

  return {
    users,
    resumes,
    credits: stats.totalCredits || 0,
    applications,
    downloads,
    optimizations,
    newUsers: stats.newUsersLastMonth || 0,
    analysisRate: pct(optimizations, resumes),
    downloadRate: pct(downloads, resumes),
    applyRate: pct(applications, resumes),
  };
};

/* ── SVG icons (inline, no external deps) ── */

const ICONS = {
  sparkles: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>`,
  arrowUpRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`,
  badgeCheck: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  fileText: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  download: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
  clipboardCheck: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>`,
};

/* ── Shared HTML wrapper ── */

const wrapHtml = (bodyContent, bgColor = "#020617") => `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1080px; height: 1080px; overflow: hidden; font-family: 'Inter', system-ui, sans-serif; background: ${bgColor}; }
  .icon { display: inline-flex; align-items: center; }
  .icon svg { display: block; }
</style>
</head>
<body>${bodyContent}</body>
</html>`;

/* ── Template: Social Proof (Trust Pulse) ── */

const buildSocialProof = (r, ctx) => {
  const statCards = [
    { value: `${fmt(r.resumes)}+`, label: "Resumes created", accent: true },
    { value: `${fmt(r.optimizations)}+`, label: "Analyses run", accent: false },
    { value: `${fmt(r.downloads)}+`, label: "CVs downloaded", accent: false },
    { value: `${fmt(r.applications)}+`, label: "Applications", accent: false },
  ];
  const rates = [
    { icon: "fileText", label: "Resumes analyzed", value: `${r.analysisRate}%` },
    { icon: "download", label: "Download rate", value: `${r.downloadRate}%` },
    { icon: "clipboardCheck", label: "Apply rate", value: `${r.applyRate}%` },
  ];
  const momentum = [
    { label: "Resumes built", value: r.resumes, bar: 100, color: "#67e8f9" },
    { label: "Analyses run", value: r.optimizations, bar: r.resumes ? Math.max(pct(r.optimizations, r.resumes), 18) : 18, color: "#a5b4fc" },
    { label: "CVs downloaded", value: r.downloads, bar: r.resumes ? Math.max(pct(r.downloads, r.resumes), 12) : 12, color: "#c4b5fd" },
  ];

  return wrapHtml(`
<div style="position:relative;width:1080px;height:1080px;overflow:hidden;background:radial-gradient(circle at 18% 18%,rgba(56,189,248,0.15),transparent 28%),linear-gradient(145deg,#020617 0%,#0f172a 48%,#312e81 100%);">
  <!-- Grid overlay -->
  <div style="position:absolute;inset:0;opacity:0.08;background-image:linear-gradient(rgba(255,255,255,0.3) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.3) 1px,transparent 1px);background-size:48px 48px;"></div>
  <!-- Glow blobs -->
  <div style="position:absolute;right:-80px;top:48px;width:420px;height:420px;border-radius:50%;background:rgba(103,232,249,0.15);filter:blur(120px);"></div>
  <div style="position:absolute;bottom:-80px;left:32px;width:420px;height:420px;border-radius:50%;background:rgba(99,102,241,0.25);filter:blur(120px);"></div>

  <div style="position:relative;z-index:10;display:flex;flex-direction:column;justify-content:space-between;height:100%;padding:48px;">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="width:56px;height:56px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;">
        <img src="${LOGO_DATA_URI}" style="width:36px;height:36px;object-fit:contain;"/>
      </div>
      <div style="flex:1;">
        <div style="font-size:30px;font-weight:700;letter-spacing:-0.025em;color:#fff;">ApplyRight</div>
        <div style="font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:0.25em;color:rgba(165,243,252,0.7);">AI-powered career platform</div>
      </div>
      <div style="display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.08);padding:8px 16px;font-size:14px;font-weight:600;color:rgba(255,255,255,0.75);">
        <span class="icon" style="color:rgba(255,255,255,0.75);">${ICONS.sparkles}</span>${ctx.generatedOn}
      </div>
    </div>

    <!-- Body -->
    <div style="display:grid;grid-template-columns:1.15fr 0.85fr;gap:24px;">
      <!-- Left -->
      <div style="display:flex;flex-direction:column;gap:24px;">
        <div>
          <div style="margin-bottom:16px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.3em;color:rgba(165,243,252,0.75);">Trusted by professionals</div>
          <div style="font-size:72px;font-weight:800;line-height:0.95;letter-spacing:-0.03em;color:#fff;">${fmt(r.users)}+ professionals building careers with AI.</div>
          <div style="margin-top:16px;max-width:520px;font-size:20px;line-height:1.4;color:#cbd5e1;">Smart resumes, ATS scoring, and AI analysis — one faster workflow.</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          ${statCards.map((c) => `
            <div style="border-radius:16px;border:1px solid ${c.accent ? "transparent" : "rgba(255,255,255,0.1)"};padding:20px;background:${c.accent ? "#fff" : "rgba(255,255,255,0.07)"};color:${c.accent ? "#020617" : "#fff"};">
              <div style="font-size:36px;font-weight:700;letter-spacing:-0.025em;line-height:1;">${c.value}</div>
              <div style="margin-top:6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7;">${c.label}</div>
            </div>`).join("")}
        </div>
      </div>
      <!-- Right -->
      <div style="display:flex;flex-direction:column;gap:12px;">
        <!-- Pulse card -->
        <div style="flex:1;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.07);padding:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#94a3b8;">
            <span>Community pulse</span>
            <span class="icon" style="color:#67e8f9;">${ICONS.badgeCheck}</span>
          </div>
          <div style="margin-top:16px;font-size:52px;font-weight:900;line-height:1;color:#fff;">+${fmt(r.newUsers)}</div>
          <div style="margin-top:6px;font-size:16px;color:#cbd5e1;">new users this month</div>
          <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px;">
            ${rates.map((item) => `
              <div style="display:flex;align-items:center;justify-content:space-between;border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(2,6,23,0.3);padding:10px 16px;">
                <div style="display:flex;align-items:center;gap:10px;color:#cbd5e1;">
                  <span class="icon" style="color:#67e8f9;">${ICONS[item.icon]}</span>
                  <span style="font-size:14px;font-weight:500;">${item.label}</span>
                </div>
                <span style="font-size:22px;font-weight:700;color:#fff;">${item.value}</span>
              </div>`).join("")}
          </div>
        </div>
        <!-- Momentum card -->
        <div style="flex:1;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(2,6,23,0.4);padding:20px;">
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#94a3b8;">Platform momentum</div>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
            ${momentum.map((m) => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:14px;color:#cbd5e1;margin-bottom:6px;"><span>${m.label}</span><span>${fmt(m.value)}</span></div>
                <div style="height:10px;border-radius:999px;background:rgba(255,255,255,0.06);overflow:hidden;">
                  <div style="height:100%;border-radius:999px;background:${m.color};width:${Math.min(m.bar, 100)}%;"></div>
                </div>
              </div>`).join("")}
          </div>
          <div style="margin-top:16px;border-radius:12px;border:1px solid rgba(103,232,249,0.15);background:rgba(103,232,249,0.1);padding:12px 16px;color:#cffafe;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.25em;color:rgba(165,243,252,0.8);">Applications tracked</div>
            <div style="margin-top:6px;font-size:24px;font-weight:700;letter-spacing:-0.025em;">${fmt(r.applications)}</div>
            <div style="margin-top:4px;font-size:12px;color:rgba(207,250,254,0.7);">Across the ApplyRight community</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="display:flex;align-items:center;justify-content:space-between;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);padding:16px 24px;">
      <div style="display:flex;gap:10px;">
        ${["AI Resume Builder", "ATS Scoring", "Interview Prep"].map((t) => `<span style="border-radius:999px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.1);padding:6px 14px;font-size:12px;font-weight:500;color:rgba(255,255,255,0.7);">${t}</span>`).join("")}
      </div>
      <div style="display:flex;align-items:center;gap:8px;border-radius:999px;background:#fff;padding:10px 16px;font-size:14px;font-weight:600;color:#020617;">
        applyright.com.ng <span class="icon">${ICONS.arrowUpRight}</span>
      </div>
    </div>
  </div>
</div>`, "#020617");
};

/* ── Template: Growth Story ── */

const buildGrowthStory = (r, ctx) => {
  const statCards = [
    { value: `${fmt(r.resumes)}+`, label: "Resumes built" },
    { value: `${fmt(r.optimizations)}+`, label: "Analyses run" },
    { value: `${fmt(r.downloads)}+`, label: "CVs downloaded" },
    { value: `${fmt(r.applications)}+`, label: "Applications" },
  ];
  const bars = [
    { label: "AI resumes built", value: `${fmt(r.resumes)}+`, bar: 100, color: "#020617" },
    { label: "Analyses run", value: `${fmt(r.optimizations)}+`, bar: r.resumes ? Math.max(pct(r.optimizations, r.resumes), 24) : 36, color: "#6366f1" },
    { label: "CVs downloaded", value: `${fmt(r.downloads)}+`, bar: r.resumes ? Math.max(pct(r.downloads, r.resumes), 20) : 28, color: "#06b6d4" },
    { label: "Applications", value: `${fmt(r.applications)}+`, bar: r.resumes ? Math.max(pct(r.applications, r.resumes), 18) : 30, color: "#7c3aed" },
  ];
  const bottomStats = [
    { value: `${fmt(r.applyRate)}%`, label: "apply rate" },
    { value: `${fmt(r.downloadRate)}%`, label: "download rate" },
    { value: `${fmt(r.credits)}+`, label: "credits held" },
  ];

  return wrapHtml(`
<div style="position:relative;width:1080px;height:1080px;overflow:hidden;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 52%,#fff 100%);">
  <div style="position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,#4f46e5,#22d3ee,#6366f1);"></div>
  <div style="position:absolute;right:-120px;top:112px;width:520px;height:520px;border-radius:50%;background:rgba(199,210,254,0.45);filter:blur(90px);"></div>
  <div style="position:absolute;bottom:-120px;left:-80px;width:420px;height:420px;border-radius:50%;background:#cffafe;filter:blur(80px);"></div>

  <div style="position:relative;z-index:10;display:flex;flex-direction:column;justify-content:space-between;height:100%;padding:48px;color:#0f172a;">
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:16px;">
        <img src="${LOGO_DATA_URI}" style="width:48px;height:48px;object-fit:contain;"/>
        <div>
          <div style="font-size:30px;font-weight:600;letter-spacing:-0.025em;color:#020617;">ApplyRight</div>
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.26em;color:rgba(79,70,229,0.8);">AI-powered career platform</div>
        </div>
      </div>
      <div style="display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;padding:8px 16px;font-size:14px;font-weight:600;color:#334155;">
        <span class="icon" style="color:#334155;">${ICONS.sparkles}</span>${ctx.generatedOn}
      </div>
    </div>

    <!-- Body -->
    <div style="display:grid;grid-template-columns:1.08fr 0.92fr;gap:28px;">
      <!-- Left -->
      <div style="display:flex;flex-direction:column;gap:24px;">
        <div>
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.32em;color:rgba(79,70,229,0.75);">Community milestone</div>
          <div style="margin-top:12px;font-size:72px;font-weight:600;line-height:0.92;letter-spacing:-0.04em;color:#020617;">${fmt(r.users)}+ professionals building careers with AI.</div>
          <div style="margin-top:16px;max-width:480px;font-size:20px;line-height:1.4;color:#475569;">AI resume generation, ATS scoring, and application support — one clean workflow.</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          ${statCards.map((c) => `
            <div style="border-radius:16px;background:rgba(255,255,255,0.8);border:1px solid rgba(226,232,240,0.6);padding:16px;">
              <div style="font-size:32px;font-weight:600;letter-spacing:-0.025em;color:#020617;">${c.value}</div>
              <div style="margin-top:4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#64748b;">${c.label}</div>
            </div>`).join("")}
        </div>
        <div style="display:flex;align-items:flex-end;gap:24px;border-top:1px solid #e2e8f0;padding-top:20px;">
          ${bottomStats.map((s) => `
            <div>
              <div style="font-size:34px;font-weight:600;letter-spacing:-0.025em;color:#020617;">${s.value}</div>
              <div style="margin-top:4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#64748b;">${s.label}</div>
            </div>`).join("")}
        </div>
      </div>
      <!-- Right panel -->
      <div style="display:flex;flex-direction:column;border-radius:32px;border:1px solid rgba(226,232,240,0.8);background:rgba(255,255,255,0.75);padding:24px;box-shadow:0 24px 80px -40px rgba(79,70,229,0.35);">
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8f0;padding-bottom:16px;">
          <div>
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:#94a3b8;">Platform highlights</div>
            <div style="margin-top:6px;font-size:22px;font-weight:600;color:#020617;">What this month looks like</div>
          </div>
          <div style="border-radius:999px;background:#eef2ff;padding:6px 12px;font-size:12px;font-weight:600;color:#4f46e5;">${ctx.periodLabel}</div>
        </div>
        <div style="margin-top:20px;display:flex;flex-direction:column;gap:20px;">
          ${bars.map((b) => `
            <div>
              <div style="display:flex;justify-content:space-between;font-size:14px;color:#64748b;margin-bottom:8px;">
                <span style="font-weight:500;text-transform:capitalize;">${b.label}</span>
                <span style="font-weight:600;color:#020617;">${b.value}</span>
              </div>
              <div style="height:12px;border-radius:999px;background:#f1f5f9;overflow:hidden;">
                <div style="height:100%;border-radius:999px;background:${b.color};width:${Math.min(b.bar, 100)}%;"></div>
              </div>
            </div>`).join("")}
        </div>
        <div style="margin-top:20px;display:flex;flex:1;flex-direction:column;gap:12px;border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="flex:1;border-radius:20px;background:#020617;padding:20px;color:#fff;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:#94a3b8;">Applications tracked</div>
            <div style="margin-top:8px;font-size:28px;font-weight:600;letter-spacing:-0.025em;">${fmt(r.applications)}+</div>
          </div>
          <div style="flex:1;border-radius:20px;background:#eef2ff;padding:20px;color:#020617;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:rgba(79,70,229,0.7);">Credits in play</div>
            <div style="margin-top:8px;font-size:28px;font-weight:600;letter-spacing:-0.025em;">${fmt(r.credits)}+</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="display:flex;align-items:center;justify-content:space-between;border-radius:16px;border:1px solid rgba(226,232,240,0.6);background:rgba(255,255,255,0.6);padding:16px 24px;">
      <div style="display:flex;gap:10px;">
        ${["AI Resume Builder", "ATS Scoring", "Interview Prep", "CV Downloads"].map((t) => `<span style="border-radius:999px;border:1px solid #e2e8f0;background:#fff;padding:6px 14px;font-size:12px;font-weight:500;color:#475569;">${t}</span>`).join("")}
      </div>
      <div style="display:flex;align-items:center;gap:8px;border-radius:999px;background:#4f46e5;padding:10px 16px;font-size:14px;font-weight:600;color:#fff;">
        applyright.com.ng <span class="icon">${ICONS.arrowUpRight}</span>
      </div>
    </div>
  </div>
</div>`, "#f8fafc");
};

/* ── Template: Impact Report ── */

const buildImpactReport = (r, ctx) => {
  const funnelWidth = (value, floor) =>
    r.users ? Math.min(Math.max(pct(value, r.users), floor), 100) : floor;
  const steps = [
    { label: "Sign-ups", value: r.users, width: 100, color: "linear-gradient(90deg,#818cf8,#6366f1)" },
    { label: "Resumes", value: r.resumes, width: funnelWidth(r.resumes, 60), color: "linear-gradient(90deg,#67e8f9,#06b6d4)" },
    { label: "Analyses", value: r.optimizations, width: funnelWidth(r.optimizations, 48), color: "linear-gradient(90deg,#c4b5fd,#8b5cf6)" },
    { label: "Downloads", value: r.downloads, width: funnelWidth(r.downloads, 42), color: "linear-gradient(90deg,#f9a8d4,#ec4899)" },
    { label: "Applications", value: r.applications, width: funnelWidth(r.applications, 36), color: "linear-gradient(90deg,#fde68a,#f59e0b)" },
  ];
  const leftStats = [
    { value: `${fmt(r.users)}+`, label: "Users" },
    { value: `${fmt(r.resumes)}+`, label: "Resumes" },
    { value: `${fmt(r.downloads)}+`, label: "Downloads" },
    { value: `${fmt(r.optimizations)}+`, label: "Analyses" },
  ];
  const topCards = [
    { label: "Total users", value: `${fmt(r.users)}+` },
    { label: "Resumes", value: `${fmt(r.resumes)}+` },
    { label: "Applications", value: `${fmt(r.applications)}+` },
  ];
  return wrapHtml(`
<div style="position:relative;display:flex;width:1080px;height:1080px;overflow:hidden;background:linear-gradient(150deg,#020617 0%,#0f172a 55%,#111827 100%);">
  <div style="position:absolute;top:0;left:0;bottom:0;width:400px;background:linear-gradient(180deg,#312e81,#1d4ed8);"></div>
  <div style="position:absolute;left:320px;top:96px;width:360px;height:360px;border-radius:50%;background:rgba(129,140,248,0.15);filter:blur(120px);"></div>
  <div style="position:absolute;right:-80px;top:-40px;width:300px;height:300px;border-radius:50%;background:rgba(103,232,249,0.1);filter:blur(110px);"></div>
  <div style="position:absolute;bottom:-80px;right:0;width:280px;height:280px;border-radius:50%;background:rgba(232,121,249,0.1);filter:blur(110px);"></div>

  <!-- Left panel -->
  <div style="position:relative;z-index:10;width:400px;display:flex;flex-direction:column;justify-content:space-between;padding:40px;color:#fff;">
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:48px;height:48px;border-radius:16px;background:rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;">
        <img src="${LOGO_DATA_URI}" style="width:32px;height:32px;object-fit:contain;"/>
      </div>
      <div>
        <div style="font-size:28px;font-weight:600;letter-spacing:-0.025em;">ApplyRight</div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.32em;color:rgba(224,231,255,0.75);">AI-powered careers</div>
      </div>
    </div>
    <div>
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.3em;color:rgba(224,231,255,0.75);">The journey</div>
      <div style="margin-top:16px;font-size:56px;font-weight:600;line-height:0.94;letter-spacing:-0.04em;">How professionals build and ship standout CVs.</div>
      <div style="margin-top:16px;max-width:280px;font-size:18px;line-height:1.45;color:rgba(224,231,255,0.8);">Real data from real professionals using ApplyRight to land their next role.</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      ${leftStats.map((s) => `
        <div style="border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.08);padding:14px 16px;">
          <div style="font-size:26px;font-weight:600;line-height:1;letter-spacing:-0.025em;">${s.value}</div>
          <div style="margin-top:6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.25em;color:rgba(224,231,255,0.6);">${s.label}</div>
        </div>`).join("")}
    </div>
    <div style="border-radius:24px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.1);padding:20px;">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.3em;color:rgba(224,231,255,0.7);">Snapshot</div>
      <div style="margin-top:12px;font-size:40px;font-weight:600;line-height:1;">${r.applyRate}%</div>
      <div style="margin-top:6px;font-size:14px;color:rgba(224,231,255,0.8);">applications per resume</div>
      <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;">
        ${[
          { label: "New users", value: `+${fmt(r.newUsers)}` },
          { label: "Resumes built", value: fmt(r.resumes) },
          { label: "CVs downloaded", value: fmt(r.downloads) },
        ].map((item) => `
          <div style="display:flex;align-items:center;justify-content:space-between;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(2,6,23,0.2);padding:10px 12px;">
            <span style="font-size:12px;color:rgba(224,231,255,0.7);">${item.label}</span>
            <span style="font-size:12px;font-weight:600;color:#fff;">${item.value}</span>
          </div>`).join("")}
      </div>
    </div>
  </div>

  <!-- Right panel -->
  <div style="position:relative;flex:1;display:flex;flex-direction:column;gap:16px;padding:40px;color:#fff;">
    <!-- Header row -->
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.32em;color:#64748b;">Current view</div>
        <div style="margin-top:6px;font-size:28px;font-weight:600;letter-spacing:-0.025em;">${ctx.periodLabel}</div>
      </div>
      <div style="border-radius:999px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);padding:6px 12px;font-size:12px;font-weight:600;color:#cbd5e1;">${ctx.generatedOn}</div>
    </div>

    <!-- Top stat cards -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
      ${topCards.map((c) => `
        <div style="border-radius:20px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:20px;">
          <div style="font-size:32px;font-weight:600;letter-spacing:-0.025em;">${c.value}</div>
          <div style="margin-top:6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#64748b;">${c.label}</div>
        </div>`).join("")}
    </div>

    <!-- Funnel card (grows to fill remaining space) -->
    <div style="flex:1;border-radius:28px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);padding:24px 24px 20px;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.32em;color:#64748b;">Funnel performance</div>
          <div style="margin-top:6px;font-size:24px;font-weight:600;letter-spacing:-0.025em;">From sign-up to application</div>
        </div>
        <div style="border-radius:999px;background:rgba(103,232,249,0.1);padding:6px 12px;font-size:12px;font-weight:600;color:#67e8f9;">${ctx.periodLabel}</div>
      </div>
      <div style="margin-top:16px;flex:1;display:flex;flex-direction:column;justify-content:space-evenly;">
        ${steps.map((s) => `
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span style="font-weight:500;color:#cbd5e1;">${s.label}</span>
              <span style="font-weight:600;color:#fff;">${fmt(s.value)}</span>
            </div>
            <div style="height:40px;border-radius:14px;background:rgba(255,255,255,0.06);overflow:hidden;">
              <div style="height:100%;border-radius:14px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:12px;font-weight:600;color:#020617;width:${s.width}%;min-width:140px;background:${s.color};">
                <span>${s.label}</span><span>${fmt(s.value)}</span>
              </div>
            </div>
          </div>`).join("")}
      </div>
    </div>

    <!-- Get started guide -->
    <div style="border-radius:24px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:#64748b;">How to get started</div>
        <div style="display:flex;align-items:center;gap:8px;border-radius:999px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);padding:6px 14px;font-size:12px;font-weight:600;color:#cbd5e1;">
          ${ICONS.sparkles} applyright.com.ng
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${[
          { num: "1", text: "Create your free account" },
          { num: "2", text: "Build a professional CV" },
          { num: "3", text: "Get an instant ATS score" },
          { num: "4", text: "Improve it with AI suggestions" },
          { num: "5", text: "Download your polished CV" },
          { num: "6", text: "Track your applications" },
        ].map((s) => `
          <div style="display:flex;align-items:center;gap:10px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);padding:10px 12px;">
            <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#818cf8);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">${s.num}</div>
            <span style="font-size:12px;font-weight:500;color:#cbd5e1;">${s.text}</span>
          </div>`).join("")}
      </div>
    </div>
  </div>
</div>`, "#020617");
};

/* ── Template builders map ── */

const TEMPLATE_BUILDERS = {
  "social-proof": buildSocialProof,
  "growth-story": buildGrowthStory,
  "impact-report": buildImpactReport,
};

/* ── Screenshot service ── */

class ScreenshotService {
  constructor() {
    this.browser = null;
  }

  async init() {
    if (!this.browser) {
      const launchOptions = await getLaunchOptions();
      this.browser = await puppeteer.launch(launchOptions);
      this.browser.on("disconnected", () => {
        this.browser = null;
      });
    }
  }

  async captureTemplate(templateId, stats, context) {
    const builder = TEMPLATE_BUILDERS[templateId];
    if (!builder) throw new Error(`Unknown template: ${templateId}`);

    const report = getReportData(stats);
    const html = builder(report, context);

    let page = null;
    try {
      await this.init();
      page = await this.browser.newPage();
      await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 3 });
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

      // Wait for Google Fonts to load
      await page.evaluate(() => document.fonts.ready);

      const buffer = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: 1080, height: 1080 },
        omitBackground: false,
      });

      return buffer;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

module.exports = new ScreenshotService();
