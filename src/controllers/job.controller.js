const { scrapeJob } = require("../services/jobScraper.service");
const Job = require("../models/Job");
const extractionService = require("../services/extraction.service");
const aiService = require("../services/ai.service");

/**
 * Check if scraped metadata looks unreliable and needs AI fallback.
 */
const isWeakMetadata = (title, company) => {
  if (!title || !company) return true;
  if (company === "Unknown Company") return true;

  // Page-title patterns: "Title | Site", "Title - Site - More"
  const pageTitlePatterns = [" | ", " — ", " :: "];
  if (pageTitlePatterns.some((p) => title.includes(p))) return true;

  // Company is a job board, not the actual employer
  const jobBoards = [
    "linkedin", "indeed", "glassdoor", "jobberman", "myjobbermag",
    "careers", "jobs", "workday", "lever", "greenhouse", "bamboohr",
  ];
  const lowerCompany = company.toLowerCase();
  if (jobBoards.some((board) => lowerCompany.includes(board))) return true;

  return false;
};

// @desc    Extract job details from URL or Description
// @route   POST /api/jobs/extract
// @access  Private
const extractJob = async (req, res) => {
  const { jobUrl, description } = req.body;

  if (!jobUrl && !description) {
    return res.status(400).json({ message: "Please provide a job URL or description" });
  }

  try {
    let title = "";
    let company = "";
    let jobDescription = "";
    let finalUrl = "";

    if (jobUrl) {
      // ── URL Path: Scrape then validate ──
      const scraped = await scrapeJob(jobUrl);
      title = scraped.title || "";
      company = scraped.company || "";
      jobDescription = scraped.description || "";
      finalUrl = scraped.jobUrl || jobUrl;

      // If scraper returned weak metadata, use AI to extract from the scraped text
      if (isWeakMetadata(title, company) && jobDescription.length > 50) {
        const aiMeta = await aiService.extractJobMetadata(jobDescription);
        if (aiMeta.title) title = aiMeta.title;
        if (aiMeta.company) company = aiMeta.company;
      }
    } else {
      // ── Text Path: Use AI to extract title and company from pasted text ──
      jobDescription = description;

      const aiMeta = await aiService.extractJobMetadata(description);
      title = aiMeta.title || "Untitled Job";
      company = aiMeta.company || "Unknown Company";
    }

    // Clean up title — strip page-title suffixes the scraper might have kept
    // e.g. "Senior Engineer | LinkedIn" → "Senior Engineer"
    const titleSeparators = [" | ", " — ", " :: ", " - "];
    for (const sep of titleSeparators) {
      if (title.includes(sep)) {
        title = title.split(sep)[0].trim();
        break;
      }
    }

    // Keyword extraction (lightweight, deterministic — runs on every job)
    const analysis = extractionService.extractRequirements(jobDescription);

    const jobToSave = {
      title: title || "Untitled Job",
      company: company || "Unknown Company",
      description: jobDescription || "No description available",
      jobUrl: finalUrl,
      keywords: analysis.skills.map((s) => s.name) || [],
      analysis: analysis,
    };

    const job = await Job.create(jobToSave);

    res.status(200).json(job);
  } catch (error) {
    console.error("Job extraction error:", error.message);
    if (error.message === "ACCESS_DENIED") {
      return res.status(403).json({ message: "Access denied to job URL" });
    }
    if (error.message === "JOB_NOT_FOUND") {
      return res.status(404).json({ message: "Job not found" });
    }
    res.status(500).json({ message: "Failed to extract job details", error: error.message });
  }
};

// @desc    Manually create a job
// @route   POST /api/jobs/manual
// @access  Private
const createJobManual = async (req, res) => {
  const { title, company, description, jobUrl } = req.body;

  if (!title || !company || !description) {
    return res.status(400).json({ message: "Please provide title, company, and description" });
  }

  try {
    const job = await Job.create({
      title,
      company,
      description,
      jobUrl: jobUrl || "",
    });

    res.status(201).json(job);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create job" });
  }
};

module.exports = {
  extractJob,
  createJobManual,
};
