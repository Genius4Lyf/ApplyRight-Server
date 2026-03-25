const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const isProduction = process.env.NODE_ENV === "production";

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

const sourceLabel = (value) => {
  if (!value) return "Direct";
  if (value === "adzuna") return "Adzuna";
  if (value === "jobberman") return "Jobberman";
  return value
    .split(/[-_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
};

const getReportData = (stats = {}) => {
  const searches = 0; // not live yet
  const clicks = stats.jobMetrics?.engagement?.totalClicks || 0;
  const saves = stats.jobMetrics?.engagement?.totalSaved || 0;
  const tailors = 0; // not live yet
  const applications = stats.totalApplications || 0;
  const downloads = stats.featureUsage?.cvGeneration?.downloads || 0;
  const optimizations = stats.featureUsage?.cvGeneration?.optimizations || 0;
  const topKeyword = stats.jobMetrics?.topKeywords?.[0]?._id || "career growth";
  const topLocation = stats.jobMetrics?.topLocations?.[0]?._id || "Nigeria";
  const sources = (stats.jobMetrics?.searchesBySource || []).slice(0, 3).map((s) => ({
    label: sourceLabel(s._id),
    count: s.count || 0,
    share: pct(s.count || 0, searches),
  }));

  return {
    users: stats.totalUsers || 0,
    resumes: stats.totalResumes || 0,
    credits: stats.totalCredits || 0,
    applications,
    searches,
    clicks,
    saves,
    tailors,
    downloads,
    optimizations,
    newUsers: stats.newUsersLastMonth || 0,
    topKeyword,
    topLocation,
    searchToApplyRate: pct(applications, searches),
    clickToSaveRate: pct(saves, clicks),
    tailorRate: pct(tailors, searches),
    sources,
  };
};

/* ── SVG icons (inline, no external deps) ── */

const ICONS = {
  sparkles: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>`,
  arrowUpRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`,
  badgeCheck: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  mouseClick: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4.1 12 6"/><path d="M5.1 8 7 10"/><path d="m6 15-1.3 1.3a2.83 2.83 0 1 0 4 4L10 19"/><path d="m12 12-8 8"/><path d="M18 11.8 14 10"/><path d="M15 2v2"/><path d="M2 15h2"/></svg>`,
  briefcase: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>`,
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
  const barColors = ["#67e8f9", "#a5b4fc", "#c4b5fd"];
  const sources = r.sources.length ? r.sources : [{ label: "Organic", count: 0, share: 0 }];
  const statCards = [
    { value: `${fmt(r.resumes)}+`, label: "Resumes created", accent: true },
    { value: `${fmt(r.searches)}+`, label: "Jobs searched", accent: false },
    { value: `${fmt(r.optimizations)}+`, label: "Analyses run", accent: false },
    { value: `${fmt(r.tailors)}+`, label: "CVs tailored", accent: false },
  ];
  const rates = [
    { icon: "search", label: "Search to apply", value: `${r.searchToApplyRate}%` },
    { icon: "mouseClick", label: "Click to save", value: `${r.clickToSaveRate}%` },
    { icon: "briefcase", label: "Tailor rate", value: `${r.tailorRate}%` },
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
          <div style="margin-top:16px;max-width:520px;font-size:20px;line-height:1.4;color:#cbd5e1;">Smart resumes, ATS scoring, and job search — one faster workflow.</div>
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
        <!-- Channel card -->
        <div style="flex:1;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(2,6,23,0.4);padding:20px;">
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:#94a3b8;">Top search channels</div>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
            ${sources.map((s, i) => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:14px;color:#cbd5e1;margin-bottom:6px;"><span>${s.label}</span><span>${s.share}%</span></div>
                <div style="height:10px;border-radius:999px;background:rgba(255,255,255,0.06);overflow:hidden;">
                  <div style="height:100%;border-radius:999px;background:${barColors[i] || barColors[2]};width:${Math.max(s.share, s.count ? 18 : 10)}%;"></div>
                </div>
              </div>`).join("")}
          </div>
          <div style="margin-top:16px;border-radius:12px;border:1px solid rgba(103,232,249,0.15);background:rgba(103,232,249,0.1);padding:12px 16px;color:#cffafe;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.25em;color:rgba(165,243,252,0.8);">Top keyword</div>
            <div style="margin-top:6px;font-size:24px;font-weight:700;letter-spacing:-0.025em;">${r.topKeyword}</div>
            <div style="margin-top:4px;font-size:12px;color:rgba(207,250,254,0.7);">Strongest interest from ${r.topLocation}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="display:flex;align-items:center;justify-content:space-between;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);padding:16px 24px;">
      <div style="display:flex;gap:10px;">
        ${["AI Resume Builder", "ATS Scoring", "Job Tracking"].map((t) => `<span style="border-radius:999px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.1);padding:6px 14px;font-size:12px;font-weight:500;color:rgba(255,255,255,0.7);">${t}</span>`).join("")}
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
    { value: `${fmt(r.searches)}+`, label: "Jobs searched" },
    { value: `${fmt(r.applications)}+`, label: "Applications" },
    { value: `${fmt(r.tailors)}+`, label: "CVs tailored" },
  ];
  const bars = [
    { label: "AI resumes built", value: `${fmt(r.resumes)}+`, bar: 100, color: "#020617" },
    { label: "Applications analyzed", value: `${fmt(r.optimizations)}+`, bar: r.resumes ? Math.max(pct(r.optimizations, r.resumes), 24) : 36, color: "#6366f1" },
    { label: "CVs tailored", value: `${fmt(r.tailors)}+`, bar: r.resumes ? Math.max(pct(r.tailors, r.resumes), 20) : 28, color: "#06b6d4" },
    { label: "Job searches", value: `${fmt(r.searches)}+`, bar: r.resumes ? Math.max(pct(r.searches, r.resumes), 30) : 50, color: "#7c3aed" },
  ];
  const bottomStats = [
    { value: `${fmt(r.searchToApplyRate)}%`, label: "search to apply" },
    { value: `${fmt(r.tailorRate)}%`, label: "search to tailor" },
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
          <div style="margin-top:16px;max-width:480px;font-size:20px;line-height:1.4;color:#475569;">AI resume generation, job discovery, and application support — one clean workflow.</div>
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
                <div style="height:100%;border-radius:999px;background:${b.color};width:${b.bar}%;"></div>
              </div>
            </div>`).join("")}
        </div>
        <div style="margin-top:20px;display:flex;flex:1;flex-direction:column;gap:12px;border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="flex:1;border-radius:20px;background:#020617;padding:20px;color:#fff;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:#94a3b8;">Top keyword</div>
            <div style="margin-top:8px;font-size:28px;font-weight:600;letter-spacing:-0.025em;">${r.topKeyword}</div>
          </div>
          <div style="flex:1;border-radius:20px;background:#eef2ff;padding:20px;color:#020617;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.28em;color:rgba(79,70,229,0.7);">Top location</div>
            <div style="margin-top:8px;font-size:28px;font-weight:600;letter-spacing:-0.025em;">${r.topLocation}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="display:flex;align-items:center;justify-content:space-between;border-radius:16px;border:1px solid rgba(226,232,240,0.6);background:rgba(255,255,255,0.6);padding:16px 24px;">
      <div style="display:flex;gap:10px;">
        ${["AI Resume Builder", "ATS Scoring", "Job Tracking", "CV Downloads"].map((t) => `<span style="border-radius:999px;border:1px solid #e2e8f0;background:#fff;padding:6px 14px;font-size:12px;font-weight:500;color:#475569;">${t}</span>`).join("")}
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
  const steps = [
    { label: "Search", value: r.searches, width: 100, color: "linear-gradient(90deg,#818cf8,#6366f1)" },
    { label: "Click", value: r.clicks, width: r.searches ? Math.max(pct(r.clicks, r.searches), 24) : 60, color: "linear-gradient(90deg,#67e8f9,#06b6d4)" },
    { label: "Save", value: r.saves, width: r.searches ? Math.max(pct(r.saves, r.searches), 20) : 48, color: "linear-gradient(90deg,#c4b5fd,#8b5cf6)" },
    { label: "Tailor", value: r.tailors, width: r.searches ? Math.max(pct(r.tailors, r.searches), 18) : 42, color: "linear-gradient(90deg,#f9a8d4,#ec4899)" },
    { label: "Apply", value: r.applications, width: r.searches ? Math.max(pct(r.applications, r.searches), 16) : 36, color: "linear-gradient(90deg,#fde68a,#f59e0b)" },
  ];
  const leftStats = [
    { value: `${fmt(r.users)}+`, label: "Users" },
    { value: `${fmt(r.resumes)}+`, label: "Resumes" },
    { value: `${fmt(r.tailors)}+`, label: "CVs tailored" },
    { value: `${fmt(r.optimizations)}+`, label: "Analyses" },
  ];
  const topCards = [
    { label: "Total users", value: `${fmt(r.users)}+` },
    { label: "Searches", value: `${fmt(r.searches)}+` },
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
      <div style="margin-top:16px;font-size:56px;font-weight:600;line-height:0.94;letter-spacing:-0.04em;">How job seekers move from search to application.</div>
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
      <div style="margin-top:12px;font-size:40px;font-weight:600;line-height:1;">${r.searchToApplyRate}%</div>
      <div style="margin-top:6px;font-size:14px;color:rgba(224,231,255,0.8);">search-to-apply conversion</div>
      <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;">
        ${[
          { label: "New users", value: `+${fmt(r.newUsers)}` },
          { label: "Top keyword", value: r.topKeyword },
          { label: "Best market", value: r.topLocation },
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
          <div style="margin-top:6px;font-size:24px;font-weight:600;letter-spacing:-0.025em;">From search to hired</div>
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
          { num: "3", text: "Tailor CV to any job" },
          { num: "4", text: "Get ATS score & tips" },
          { num: "5", text: "Search & apply to jobs" },
          { num: "6", text: "Track all applications" },
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
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--font-render-hinting=none",
      ];
      if (isProduction) {
        args.push("--single-process", "--no-zygote");
      }
      const launchOptions = {
        headless: true,
        args,
        ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        }),
      };
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
