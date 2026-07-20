const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("../models/User");
const DraftCV = require("../models/DraftCV");
const subscription = require("../services/subscription.service");
const settingsService = require("../services/settings.service");
const aiService = require("../services/ai.service");
const { coachState } = require("../services/atsCoach.service");

// The valid Role-Brief company types (mirrors DraftCV.targetJob.brief.companyType
// and ai.service's framing map). Used to validate the infer+confirm chip.
const COMPANY_TYPES = ["startup", "enterprise", "agency", "nonprofit", "government", "smb", "unknown"];

// Human labels for the builder steps (mirrors the frontend STEP_NOUNS). Used to
// tell Aria which section the student is on. Falls back to 'your CV'.
const STEP_LABELS = {
  target_job: "target job",
  heading: "contact details",
  history: "work history",
  projects: "projects",
  education: "education",
  skills: "skills",
  summary: "summary",
  finalize: "review",
};

// Resolve (and cache) Aria's Role Brief for a draft. The brief is keyed by a hash
// of the current JD text: a cache hit (brief present AND briefHash matches the
// current JD) returns the stored brief untouched — crucially preserving a
// user-confirmed companyType. On a miss (no brief, or the JD changed) it rebuilds
// via aiService.buildRoleBrief, persists brief + briefHash, and returns it.
const resolveDraftBrief = async (draft, meta) => {
  const jd = (draft.targetJob?.description || "").trim();
  if (!jd) return null;
  const hash = crypto.createHash("sha256").update(jd).digest("hex");

  const cached = draft.targetJob?.brief;
  if (cached && draft.targetJob?.briefHash === hash) {
    // JD unchanged — return the cached brief as-is (keeps a confirmed companyType).
    return cached.toObject ? cached.toObject() : cached;
  }

  const brief = await aiService.buildRoleBrief(jd, { title: draft.targetJob?.title }, meta);
  draft.targetJob.brief = brief;
  draft.targetJob.briefHash = hash;
  await draft.save();
  return brief;
};

// @desc    Live conversational CV coach — a short, personal, gap-aware message
//          (and optional step-by-step guide) for the user's current step. Free
//          users get a daily quota; paid tiers are unlimited. Always degrades to
//          a client-side scripted fallback (never blank, never hard-blocks).
// @route   POST /api/coach/guide
// @access  Private (job-seekers only)
const guide = async (req, res) => {
  const { draftId, step, signal, cvData } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    let draft;
    if (draftId === "new") {
      draft = cvData || {};
    } else {
      if (!mongoose.Types.ObjectId.isValid(draftId)) {
        return res.status(400).json({ message: "Invalid draftId format" });
      }
      draft = await DraftCV.findById(draftId);
      if (!draft) {
        return res.status(404).json({ message: "CV not found" });
      }
      if (draft.userId.toString() !== req.user.id) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    const user = await User.findById(req.user.id).select("plan subscription");
    // The conversational coach is a PAID feature, gated on the effective subscription
    // (subscription.isPaidActive — honors expiry, the canonical paid check used across
    // the backend). Free users get the deterministic CV Journey only — no AI coaching.
    if (!subscription.isPaidActive(user)) {
      return res.json({ locked: true });
    }

    // Prefer the live cvData the client sends (what the user has typed RIGHT NOW)
    // over the saved draft, which lags until a step transition. Falls back to the
    // draft when no live state is provided.
    const gaps = coachState(cvData && typeof cvData === "object" ? cvData : draft);
    let result;
    try {
      result = await aiService.coachMessage(
        {
          firstName: gaps.firstName,
          step: step || draft.currentStep || "",
          gaps,
          signal: (signal || "").toString().slice(0, 200),
        },
        { userId: req.user.id, operation: "coachGuide" }
      );
    } catch (err) {
      if (err instanceof aiService.AIUnavailableError) {
        return res.json({ fallback: true });
      }
      throw err;
    }

    return res.json({ ...result });
  } catch (error) {
    console.error("Coach Guide Error:", error);
    // Soft-fail to the client's scripted coach rather than erroring the UI.
    return res.json({ fallback: true });
  }
};

// @desc    Aria "build-with" bullet generation — turn a described role/project into
//          `count` truthful, Role-Brief-grounded bullets. Charges count × GENERATE_BULLET
//          (paid tiers draw from allowance via chargeOrSkip). The first re-roll of an
//          identical request is free (genState bookkeeping). Does NOT auto-apply — the
//          frontend shows the bullets and the user appends them via the autosave path.
// @route   POST /api/coach/generate-bullets
// @access  Private (job-seekers only — not CV-agent client CVs)
const generateBullets = async (req, res) => {
  const { draftId, section, sortId, description, count, reroll } = req.body || {};
  if (!draftId || !sortId || !["experience", "project"].includes(section)) {
    return res
      .status(400)
      .json({ message: "draftId, section ('experience'|'project') and sortId are required" });
  }
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    return res.status(400).json({ message: "count must be an integer between 1 and 6" });
  }
  const desc = String(description || "").trim();
  if (desc.length < 15) {
    return res.status(400).json({ message: "Describe what you did in a bit more detail (at least 15 characters)." });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    const list = section === "experience" ? draft.experience : draft.projects;
    const entry = (list || []).find((e) => e._sortId === sortId);
    if (!entry) {
      return res.status(404).json({ message: "That role is no longer in your CV. Refresh and try again." });
    }

    const user = await User.findById(req.user.id).select("plan subscription credits");
    const meta = { userId: req.user.id, operation: "coachGenerateBullets" };

    // Ground on the Role Brief. Non-fatal: fall back to a brief-less generation.
    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach resolveDraftBrief error (generateBullets, brief-less):", briefErr.message);
    }

    // count × per-bullet cost (admin-overridable, same resolver as REWRITE_ROLE).
    const perBullet = (await settingsService.getCreditCosts()).GENERATE_BULLET;
    const cost = n * perBullet;

    // The first re-roll of an IDENTICAL request (same section+sortId+description+count)
    // is free — a charged generation re-grants exactly one; using it flips the flag.
    const descHash = crypto
      .createHash("sha256")
      .update(`${section}|${sortId}|${desc}|${n}`)
      .digest("hex");
    const entryState = draft.genState?.[sortId];
    const isFreeReroll =
      reroll === true && entryState?.hash === descHash && entryState?.freeRerollAvailable === true;

    // PRE-CHECK the balance before spending an AI call the user can't pay for
    // (paid tiers pass via their allowance — availableCredits includes it).
    if (!isFreeReroll && subscription.availableCredits(user) < cost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    let bullets;
    try {
      bullets = await aiService.generateBulletsFromDescription(desc, n, {
        brief,
        role: entry.title || (section === "experience" ? "this role" : "this project"),
        section,
        model: aiService.resolveTextModel(user), // tier-based (paid → stronger model)
        meta,
      });
    } catch (genErr) {
      if (genErr instanceof aiService.AIUnavailableError) {
        return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach generateBullets AI error:", genErr.message);
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }
    if (!Array.isArray(bullets) || bullets.length === 0) {
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }

    // Charge on success (skipped for a free re-roll). Rare race: a concurrent spend
    // between the pre-check and here can still come back insufficient.
    if (!isFreeReroll) {
      const charge = await subscription.chargeOrSkip(user, cost, {
        type: "generate_bullet",
        description: `Aria bullets (${n})`,
      });
      if (charge.insufficient) {
        return res.status(402).json({
          code: "INSUFFICIENT_CREDITS",
          message: "Insufficient credits",
          required: cost,
          remainingCredits: subscription.availableCredits(user),
        });
      }
    }

    // Re-grant exactly one free re-roll for this exact request; a free re-roll
    // consumes it (freeRerollAvailable=false) so only the immediate next is free.
    if (!draft.genState) draft.genState = {};
    draft.genState[sortId] = { hash: descHash, freeRerollAvailable: !isFreeReroll };
    draft.markModified("genState");
    await draft.save();

    return res.json({
      bullets,
      wasFree: isFreeReroll,
      cost: isFreeReroll ? 0 : cost,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Generate Bullets Error:", error);
    return res.status(500).json({ message: "Failed to generate bullets" });
  }
};

// @desc    Generate ONE career-stage-aware, JD-tailored professional summary.
//          Credited per draft (each re-roll charges again), mirroring generateBullets'
//          charge pattern: pre-check balance → generate → charge on confirmed success.
// @route   POST /api/coach/summary
// @access  Private
const summary = async (req, res) => {
  const { draftId, stage } = req.body || {};
  if (!draftId || !["experienced", "grad", "changer"].includes(stage)) {
    return res
      .status(400)
      .json({ message: "draftId and stage ('experienced'|'grad'|'changer') are required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    const user = await User.findById(req.user.id).select("plan subscription credits");
    const cost = (await settingsService.getCreditCosts()).GENERATE_SUMMARY;

    // PRE-CHECK the balance before spending an AI call the user can't pay for
    // (paid tiers pass via their allowance — availableCredits includes it).
    if (subscription.availableCredits(user) < cost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    // Build the grounding context server-side — same shape ProfessionalSummary.jsx
    // assembled client-side (name, target title, skills list, work-history one-liners,
    // existing summary draft).
    const skillsStr = (draft.skills || [])
      .map((s) => (typeof s === "object" ? s.type || s.name : s))
      .filter(Boolean)
      .join(", ");
    const historyStr = (draft.experience || [])
      .map((exp) => `${exp.title} at ${exp.company} (${exp.startDate}-${exp.isCurrent ? "Present" : exp.endDate})`)
      .join("; ");
    const context = `
                Candidate Name: ${draft.personalInfo?.fullName || "Candidate"}
                Target Job Title: ${draft.targetJob?.title || "Professional"}

                Key Skills: ${skillsStr}

                Work History Summary: ${historyStr}

                Existing Summary Draft: ${draft.professionalSummary || ""}
            `.trim();

    let result;
    try {
      result = await aiService.generateSummaryForStage({
        stage,
        role: draft.targetJob?.title || "Professional",
        context,
        jobDescription: (draft.targetJob?.description || "").trim(),
        model: aiService.resolveTextModel(user), // tier-based (paid → stronger model)
        meta: { userId: req.user.id, operation: "coachSummary" },
      });
    } catch (genErr) {
      if (genErr instanceof aiService.AIUnavailableError) {
        return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach summary AI error:", genErr.message);
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }

    // generateSummaryForStage returns the summary STRING directly.
    const text = (result || "").trim();
    if (!text) {
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }

    // Charge on confirmed success. Rare race: a concurrent spend between the pre-check
    // and here can still come back insufficient.
    const charge = await subscription.chargeOrSkip(user, cost, {
      type: "generate_summary",
      description: "Aria summary",
    });
    if (charge.insufficient) {
      return res.status(402).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    return res.json({
      summary: text,
      cost,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Summary Error:", error);
    return res.status(500).json({ message: "Failed to generate summary" });
  }
};

// @desc    Confirm or correct the inferred company type on Aria's Role Brief.
//          Powers the infer+confirm chip: sets companyType + marks it confirmed
//          so a later brief rebuild (same JD) keeps the user's choice.
// @route   POST /api/coach/company-type
// @access  Private
const setCompanyType = async (req, res) => {
  const { draftId, companyType } = req.body || {};
  if (!draftId || !companyType) {
    return res.status(400).json({ message: "draftId and companyType are required" });
  }
  if (!COMPANY_TYPES.includes(companyType)) {
    return res.status(400).json({ message: `companyType must be one of: ${COMPANY_TYPES.join(", ")}` });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    // Ensure the brief subdoc exists (it may not yet if no rewrite/scan has run).
    if (!draft.targetJob) draft.targetJob = {};
    if (!draft.targetJob.brief) draft.targetJob.brief = {};
    draft.targetJob.brief.companyType = companyType;
    draft.targetJob.brief.companyTypeConfirmed = true;
    await draft.save();

    const brief = draft.targetJob.brief;
    return res.json({ brief: brief.toObject ? brief.toObject() : brief });
  } catch (error) {
    console.error("Coach Set Company Type Error:", error);
    return res.status(500).json({ message: "Failed to update company type" });
  }
};

// Shared Aria-chat daily allowance. ONE free pool covers BOTH the section chat
// (/coach/ask) and the unified /coach/chat (general + build-with): 15 messages/day
// per user (calendar-date window), then ARIA_CHAT_MESSAGE credits each (paid users
// included — no exemption past the free daily allowance).
const FREE_DAILY_CHATS = 15;

// Pre-check the allowance (BEFORE the AI call). Returns today's key, how many chats
// were used in that window, and whether this turn will charge credits.
const chatAllowance = (user) => {
  const today = new Date().toISOString().slice(0, 10);
  const used = user.ariaChat?.date === today ? user.ariaChat.count || 0 : 0;
  return { today, used, willCharge: used >= FREE_DAILY_CHATS };
};

// Commit a chat turn AFTER the AI succeeds: charge a credit (past the free pool) or
// bump the daily free counter. Returns { insufficient } on a lost charge race, else
// { charged, freeRemaining }.
const commitChatTurn = async (user, pre, cost) => {
  if (pre.willCharge) {
    const r = await subscription.chargeOrSkip(user, cost, { type: "aria_chat", description: "Aria chat" });
    if (r.insufficient) return { insufficient: true };
  } else {
    user.ariaChat = { date: pre.today, count: pre.used + 1 };
  }
  await user.save();
  return {
    charged: pre.willCharge,
    freeRemaining: Math.max(0, FREE_DAILY_CHATS - (pre.willCharge ? pre.used : pre.used + 1)),
  };
};

// @desc    Aria's free-form coach chat. Warm, on-task, guardrailed Q&A about the
//          current CV/section/target role on the CHEAP base model. Draws from the
//          shared daily chat allowance (see FREE_DAILY_CHATS), then credits.
// @route   POST /api/coach/ask
// @access  Private (job-seekers only — not CV-agent client CVs)
const askAria = async (req, res) => {
  const { draftId, currentStepId, question } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ message: "question is required" });
  }
  const q = question.trim();
  if (q.length < 1 || q.length > 500) {
    return res.status(400).json({ message: "question must be between 1 and 500 characters" });
  }
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to view this CV" });
    }

    const user = await User.findById(req.user.id).select("plan subscription credits ariaChat");

    // Shared daily allowance (section chat + build-with). Past the free pool every
    // user (paid included) spends credits — no tier exemption.
    const pre = chatAllowance(user);
    const cost = (await settingsService.getCreditCosts()).ARIA_CHAT_MESSAGE;

    // Pre-check the balance before spending an AI call the user can't pay for.
    if (pre.willCharge && subscription.availableCredits(user) < cost) {
      return res.status(402).json({
        code: "CHAT_LIMIT_REACHED",
        message: "You've used today's free chats — top up credits or come back tomorrow.",
        remainingCredits: subscription.availableCredits(user),
        freeRemaining: 0,
      });
    }

    // Compact, cheap context: target title + one line of section-progress counts.
    const meta = { userId: req.user.id, operation: "coachAskAria" };
    const targetTitle = (draft.targetJob?.title || draft.targetJob?.brief?.role || "").trim();
    const cvSummary = `${targetTitle ? `Target: ${targetTitle}. ` : ""}Progress: ${
      draft.experience?.length || 0
    } roles, ${draft.projects?.length || 0} projects, ${draft.skills?.length || 0} skills, summary ${
      draft.professionalSummary?.trim() ? "written" : "empty"
    }.`;

    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach askAria resolveDraftBrief error (brief-less):", briefErr.message);
    }

    const stepLabel = STEP_LABELS[currentStepId] || "your CV";

    let answer;
    try {
      answer = await aiService.answerCoachQuestion({ question: q, stepLabel, cvSummary, brief, meta });
    } catch (aiErr) {
      if (aiErr instanceof aiService.AIUnavailableError) {
        return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach askAria AI error:", aiErr.message);
      return res.status(502).json({ message: "Couldn't answer right now. Please try again." });
    }

    // Charge-or-count only AFTER a successful answer (no charge/increment on failure).
    const c = await commitChatTurn(user, pre, cost);
    if (c.insufficient) {
      return res.status(402).json({
        code: "CHAT_LIMIT_REACHED",
        message: "You've used today's free chats — top up credits or come back tomorrow.",
        remainingCredits: subscription.availableCredits(user),
        freeRemaining: 0,
      });
    }

    return res.json({ answer, freeRemaining: c.freeRemaining, charged: c.charged });
  } catch (error) {
    console.error("Coach Ask Aria Error:", error);
    return res.status(500).json({ message: "Failed to answer" });
  }
};

// Hard per-round turn cap for focused build-with in /coach/chat: at the cap, the
// model is forced to wrap up to a draft so the conversation always converges.
const INTERVIEW_TURN_CAP = 6;

// @desc    Aria's UNIFIED chat — ONE front door. Focus-aware + intent-classified on
//          the CHEAP base model: a focused 'building'/'ready' turn is FREE (build-with);
//          a general question ('answer') spends the daily allowance. Charging is
//          SMART PER-MESSAGE. Same guardrails/allowance as /coach/ask.
// @route   POST /api/coach/chat
// @access  Private (job-seekers only — not CV-agent client CVs)
const chat = async (req, res) => {
  const { draftId, currentStepId, messages, focus, buildTurns } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }
  if (focus && !(["experience", "project"].includes(focus.section) && focus.sortId)) {
    return res
      .status(400)
      .json({ message: "focus must be { section: 'experience'|'project', sortId }" });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ message: "messages must be a non-empty array" });
  }
  // Normalize + validate: the LAST message must be the user's new turn.
  const turns = messages
    .filter((m) => m && (m.who === "aria" || m.who === "user") && typeof m.text === "string")
    .map((m) => ({ who: m.who, text: m.text.trim() }))
    .filter((m) => m.text);
  const last = turns[turns.length - 1];
  if (!last || last.who !== "user") {
    return res.status(400).json({ message: "The last message must be the user's turn." });
  }
  if (last.text.length > 800) {
    last.text = last.text.slice(0, 800);
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    // Resolve the focused entry (if the client is on a specific role/project).
    let entry = null;
    if (focus) {
      const list = focus.section === "experience" ? draft.experience : draft.projects;
      entry = (list || []).find((e) => e._sortId === focus.sortId);
      if (!entry) {
        return res.status(404).json({ message: "That role is no longer in your CV. Refresh and try again." });
      }
    }

    const user = await User.findById(req.user.id).select("plan subscription credits ariaChat");
    const pre = chatAllowance(user);
    const cost = (await settingsService.getCreditCosts()).ARIA_CHAT_MESSAGE;

    // The per-interview turn cap only bounds focused BUILDING (forces a draft).
    const mustFinish = !!focus && Number(buildTurns) >= INTERVIEW_TURN_CAP;

    const meta = { userId: req.user.id, operation: "coachChatTurn" };
    const targetTitle = (draft.targetJob?.title || draft.targetJob?.brief?.role || "").trim();
    const cvSummary = `${targetTitle ? `Target: ${targetTitle}. ` : ""}Progress: ${
      draft.experience?.length || 0
    } roles, ${draft.projects?.length || 0} projects, ${draft.skills?.length || 0} skills, summary ${
      draft.professionalSummary?.trim() ? "written" : "empty"
    }.`;

    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach chat resolveDraftBrief error (brief-less):", briefErr.message);
    }

    const stepLabel = STEP_LABELS[currentStepId] || "your CV";
    const window = turns.slice(-12); // bounded memory sent to the model

    // NO focus → every turn is a general answer (metered like /coach/ask). Pre-check
    // the balance BEFORE spending an AI call the user can't pay for.
    if (!focus && pre.willCharge && subscription.availableCredits(user) < cost) {
      return res.status(402).json({
        code: "CHAT_LIMIT_REACHED",
        message: "You've used today's free chats — top up or come back tomorrow.",
        freeRemaining: 0,
      });
    }

    let result;
    try {
      result = await aiService.coachChatTurn({
        messages: window,
        focus: !!focus,
        entryTitle: entry?.title || "this role",
        entryCompany: (entry?.company || "").trim(),
        section: focus?.section || "",
        stepLabel,
        cvSummary,
        brief,
        mustFinish,
        meta,
      });
    } catch (aiErr) {
      if (aiErr instanceof aiService.AIUnavailableError) {
        return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach chat AI error:", aiErr.message);
      return res.status(502).json({ message: "Couldn't continue right now. Please try again." });
    }

    // No focus → always a general answer; focused → trust the classifier.
    const intent = focus ? result.intent : "answer";

    // SMART PER-MESSAGE charging: only a general 'answer' spends the allowance;
    // 'building'/'ready' (focused build-with) is FREE — no charge, no counter bump.
    let charged = false;
    let freeRemaining = Math.max(0, FREE_DAILY_CHATS - pre.used);
    if (intent === "answer") {
      const c = await commitChatTurn(user, pre, cost);
      if (c.insufficient) {
        // They can't pay for a general answer — don't leak the reply. (They can still
        // build for free on a focused role.)
        return res.status(402).json({
          code: "CHAT_LIMIT_REACHED",
          message: "You've used today's free chats — top up or come back tomorrow.",
          freeRemaining: 0,
        });
      }
      charged = c.charged;
      freeRemaining = c.freeRemaining;
    }

    return res.json({
      reply: result.reply,
      intent,
      readyToDraft: intent === "ready" || (!!focus && mustFinish),
      description: intent === "ready" ? result.description : "",
      // Answer scaffolds — only while building (Aria just asked a follow-up).
      suggestions: intent === "building" ? result.suggestions || [] : [],
      exampleAnswer: intent === "building" ? result.exampleAnswer || "" : "",
      suggestionsLabel: intent === "building" ? result.suggestionsLabel || "" : "",
      freeRemaining,
      charged,
    });
  } catch (error) {
    console.error("Coach Chat Error:", error);
    return res.status(500).json({ message: "Failed to continue the chat" });
  }
};

// @desc    Fetch (or build+cache) Aria's Role Brief for a draft — powers the
//          "Aria's read" strip + the infer+confirm company-type chip. Cheap: a
//          same-JD read returns the cached brief (no fresh AI spend). No JD → null.
// @route   POST /api/coach/brief
// @access  Private (job-seekers only — not CV-agent client CVs)
const getBrief = async (req, res) => {
  const { draftId } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to view this CV" });
    }

    // No target job → no brief (the flow still works without one).
    if (!(draft.targetJob?.description || "").trim()) {
      return res.json({ brief: null });
    }

    const brief = await resolveDraftBrief(draft, { userId: req.user.id, operation: "coachGetBrief" });
    return res.json({ brief });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res.status(503).json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Get Brief Error:", error);
    return res.status(502).json({ message: "Couldn't read the job right now. Please try again." });
  }
};

module.exports = {
  guide,
  generateBullets,
  summary,
  setCompanyType,
  getBrief,
  askAria,
  chat,
};
