const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

let openai;
let geminiModel;
let activeProvider = "mock"; // 'openai', 'gemini', or 'mock'

// Initialize Clients
// Initialize Clients
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  activeProvider = "openai";
  console.log("✅ AI Service: OpenAI Enabled");
} else if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Use a fast model
  activeProvider = "gemini";
  console.log("✅ AI Service: Gemini Enabled");
} else {
  // Requested Enhancement: Explicitly log error to terminal when keys are missing
  console.log("\n❌ [ERROR] AI Service Initialization Failed");
  console.log("   Reason: No API Keys found (OPENAI_API_KEY or GEMINI_API_KEY)");
  console.log("   Action: Falling back to Mock Mode. Real analysis will not work.\n");
}

/**
 * Smart truncation: keeps content from both the start and end of the text
 * so that sections at the bottom (skills, education) aren't lost.
 * If the text fits within maxLen, returns it as-is.
 */
const smartTruncate = (text, maxLen) => {
  if (!text || text.length <= maxLen) return text || "";
  const headSize = Math.ceil(maxLen * 0.7);
  const tailSize = maxLen - headSize - 20; // 20 chars for separator
  const head = text.substring(0, headSize);
  const tail = text.substring(text.length - tailSize);
  return `${head}\n\n[... content trimmed ...]\n\n${tail}`;
};

/**
 * Extract structured requirements from a job description.
 * Returns skills (classified by importance), experience requirements,
 * education requirements, seniority level, and metadata.
 */
const extractJobRequirements = async (jobDescription) => {
  if (activeProvider === "mock") {
    return {
      detectedJobTitle: "Software Engineer",
      detectedCompany: "Mock Company",
      requiredSkills: [
        { name: "JavaScript", importance: "must_have" },
        { name: "React", importance: "must_have" },
      ],
      preferredSkills: [
        { name: "Docker", importance: "nice_to_have" },
      ],
      requiredYearsExperience: 3,
      requiredEducation: { degree: "Bachelor's", field: "Computer Science" },
      seniorityLevel: "mid",
    };
  }

  const prompt = `
    You are a Job Description Parser. Extract ONLY factual requirements from this job posting.
    Do NOT infer or assume — only extract what is explicitly stated or very strongly implied.

    JOB DESCRIPTION:
    ${smartTruncate(jobDescription, 16000)}

    INSTRUCTIONS:
    1. "detectedJobTitle": The specific role being advertised. Look for "Position:", "Role:", "Job Title:", or the main heading. Do NOT include the company name.
    2. "detectedCompany": The hiring company. Ignore recruitment agencies and job boards (e.g., "Jobberman", "LinkedIn"). If not found, use null.
    3. "requiredSkills": Skills explicitly listed under "Requirements", "Must have", "Required", or strongly emphasized. Each as { "name": "<skill>", "importance": "must_have" }.
    4. "preferredSkills": Skills listed under "Preferred", "Nice to have", "Bonus", or mentioned casually. Each as { "name": "<skill>", "importance": "nice_to_have" }.
    5. "requiredYearsExperience": Number of years explicitly required (e.g., "3+ years"). If not stated, use 0.
    6. "requiredEducation": { "degree": "<minimum degree>", "field": "<field if specified>" }. If not stated, use null.
    7. "seniorityLevel": One of "intern", "entry", "mid", "senior", "lead", "manager", "director", "executive". Infer from title and requirements.

    Return STRICT JSON only. No markdown code blocks. No extra text.
    {
        "detectedJobTitle": "...",
        "detectedCompany": "...",
        "requiredSkills": [{ "name": "...", "importance": "must_have" }],
        "preferredSkills": [{ "name": "...", "importance": "nice_to_have" }],
        "requiredYearsExperience": 0,
        "requiredEducation": { "degree": "...", "field": "..." },
        "seniorityLevel": "..."
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Job Extraction Failed:", error);
    return {
      detectedJobTitle: null,
      detectedCompany: null,
      requiredSkills: [],
      preferredSkills: [],
      requiredYearsExperience: 0,
      requiredEducation: null,
      seniorityLevel: "mid",
    };
  }
};

/**
 * Extract structured candidate data from resume text.
 * Lighter version of extractResumeProfile focused on analysis needs.
 */
const extractCandidateData = async (resumeText) => {
  if (activeProvider === "mock") {
    return {
      skills: ["JavaScript", "React", "Node.js"],
      totalYearsExperience: 2,
      seniorityLevel: "entry",
      education: [{ degree: "Bachelor's", field: "Computer Science", school: "Mock Univ" }],
      experience: [{ role: "Developer", company: "Mock Co", years: 2 }],
      projects: [{ title: "Mock Project" }],
      summary: "Mock candidate summary.",
    };
  }

  const prompt = `
    You are an expert Resume Analyzer. Extract structured data for job matching.

    RESUME TEXT:
    ${smartTruncate(resumeText, 16000)}

    INSTRUCTIONS:
    1. "skills": ALL skills, tools, technologies, and competencies demonstrated (through experience, projects, education, or explicit listing). Be thorough — include implied skills too (e.g., if they built a REST API, include "REST APIs", "API Development").
    2. "totalYearsExperience": Total PROFESSIONAL years of experience. Calculate from work history dates. Round to nearest integer.
    3. "seniorityLevel": One of "intern", "entry", "mid", "senior", "lead", "manager", "director", "executive". Based on most recent titles and total experience.
    4. "education": Array of { "degree": "...", "field": "...", "school": "..." }.
    5. "experience": Array of { "role": "...", "company": "...", "years": <number> } — years at each role.
    6. "projects": Array of { "title": "..." } — project names if any.
    7. "summary": A brief 1-2 sentence summary of who this candidate is professionally.

    Return STRICT JSON only. No markdown code blocks:
    {
        "skills": ["..."],
        "totalYearsExperience": 0,
        "seniorityLevel": "...",
        "education": [{ "degree": "...", "field": "...", "school": "..." }],
        "experience": [{ "role": "...", "company": "...", "years": 0 }],
        "projects": [{ "title": "..." }],
        "summary": "..."
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Candidate Extraction Failed:", error);
    return {
      skills: [],
      totalYearsExperience: 0,
      seniorityLevel: "mid",
      education: [],
      experience: [],
      projects: [],
      summary: "",
    };
  }
};

/**
 * Generate human-readable feedback constrained by pre-computed scores.
 * AI writes the narrative but cannot change the numbers.
 */
const generateAnalysisFeedback = async (scoringResult, candidateData, jobData) => {
  if (activeProvider === "mock") {
    return {
      overallFeedback: "Analysis performed in Mock/Offline Mode. Add an API key for real analysis.",
      recommendation: "Add an API Key to enable AI analysis.",
    };
  }

  const prompt = `
    You are an expert Career Advisor. Write human-readable feedback for a job fit analysis.
    The scores have ALREADY been computed deterministically — you MUST NOT change them.
    Your job is ONLY to explain the results in a helpful, encouraging way.

    COMPUTED RESULTS (DO NOT MODIFY):
    - Fit Score: ${scoringResult.fitScore}/100
    - Skills Score: ${scoringResult.scoreBreakdown.skillsScore}/100
    - Experience Score: ${scoringResult.scoreBreakdown.experienceScore}/100
    - Education Score: ${scoringResult.scoreBreakdown.educationScore}/100
    - Seniority Score: ${scoringResult.scoreBreakdown.seniorityScore}/100
    - Matched Skills: ${scoringResult.matchedSkills.map(s => s.name).join(", ") || "None"}
    - Missing Skills: ${scoringResult.missingSkills.map(s => s.name).join(", ") || "None"}
    - Experience: ${scoringResult.experienceAnalysis.candidateYears} years (need ${scoringResult.experienceAnalysis.requiredYears})
    - Candidate Level: ${scoringResult.seniorityAnalysis.candidateLevel}
    - Required Level: ${scoringResult.seniorityAnalysis.requiredLevel}

    CANDIDATE SUMMARY: ${candidateData.summary || "Not available"}
    JOB TITLE: ${jobData.detectedJobTitle || "Unknown"}
    COMPANY: ${jobData.detectedCompany || "Unknown"}

    INSTRUCTIONS:
    1. Write "overallFeedback": 2-3 sentences summarizing the fit. Mention strengths first, then gaps. Be specific.
    2. Write "recommendation": 1-2 sentences of actionable advice. Be specific about what to do (not generic).

    Return STRICT JSON only:
    {
        "overallFeedback": "...",
        "recommendation": "..."
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Feedback Generation Failed:", error);
    return {
      overallFeedback: `Your fit score is ${scoringResult.fitScore}/100. ${scoringResult.matchedSkills.length} skills matched, ${scoringResult.missingSkills.length} skills missing.`,
      recommendation: scoringResult.recommendation === "strong_match"
        ? "You're a strong match. Tailor your resume keywords to mirror the job description."
        : "Focus on addressing skill gaps and highlighting transferable experience.",
    };
  }
};

/**
 * NEW PIPELINE: analyzeProfile
 *
 * Stage 1: Extract candidate data from resume (AI)
 * Stage 2: Extract job requirements from JD (AI)
 * Stage 3: Normalize skills & compute deterministic score (no AI)
 * Stage 4: Generate human-readable feedback constrained by scores (AI)
 */
const { computeFitScore } = require("./scoringEngine.service");

const analyzeProfile = async (resumeText, jobDescription) => {
  if (activeProvider === "mock") {
    return mockAnalysis();
  }

  try {
    // Stage 1 & 2: Parallel AI extraction (resume + JD)
    console.log("[Analysis Pipeline] Stage 1-2: Extracting candidate & job data...");
    const [candidateData, jobData] = await Promise.all([
      extractCandidateData(resumeText),
      extractJobRequirements(jobDescription),
    ]);

    // Stage 3: Deterministic scoring (no AI)
    console.log("[Analysis Pipeline] Stage 3: Computing deterministic scores...");
    const scoringResult = computeFitScore({ candidateData, jobData });

    // Stage 4: AI feedback constrained by scores
    console.log("[Analysis Pipeline] Stage 4: Generating feedback...");
    const feedback = await generateAnalysisFeedback(scoringResult, candidateData, jobData);

    console.log("[Analysis Pipeline] Complete. Fit score:", scoringResult.fitScore);

    return {
      detectedJobTitle: jobData.detectedJobTitle,
      detectedCompany: jobData.detectedCompany,
      fitScore: scoringResult.fitScore,
      matchedSkills: scoringResult.matchedSkills,
      missingSkills: scoringResult.missingSkills,
      experienceAnalysis: scoringResult.experienceAnalysis,
      seniorityAnalysis: scoringResult.seniorityAnalysis,
      scoreBreakdown: scoringResult.scoreBreakdown,
      overallFeedback: feedback.overallFeedback,
      recommendation: feedback.recommendation,
      actionPlan: scoringResult.actionPlan,
      mode: "AI",
      provider: activeProvider,
    };
  } catch (error) {
    console.error("Analysis Pipeline Failed, falling back to mock:", error);
    return mockAnalysis();
  }
};

const generateOptimizedContent = async (resumeText, jobDescription, userContext = {}) => {
  // If mock mode, return the old mock response
  if (activeProvider === "mock") {
    const currentYear = new Date().getFullYear();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Latency sim

    const mockOptimizedCV = `
# ALEXANDER JAMES

## Professional Summary
Results-oriented Software Engineer with 4+ years of experience in full-stack development, specializing in MERN stack applications. Proven track record of improving system performance by 40% and reducing deployment times by 60% through CI/CD optimization. Adept at translating complex requirements into scalable, clean code solutions.

## Work History
### Senior Frontend Developer
TechSolutions Inc. | Jan 2023 - Present
- Spearheaded the migration of a legacy Monolith to Microservices using Node.js and Docker, resulting in a 99.9% uptime.
- Mentored a team of 5 junior developers, establishing code quality standards that reduced bug reports by 30%.
- Optimized React application state management using Redux Toolkit, decreasing load times by 2.5 seconds.
- Integrated third-party payment gateways (Stripe) to facilitate secure global transactions.

### Web Developer
Creative Agency Ltd. | Jun 2021 - Dec 2022
- Developed responsive, accessible user interfaces for 15+ client websites using HTML5, CSS3, and React.
- Collaborated with UX/UI designers to implement pixel-perfect designs, ensuring cross-browser compatibility.
- Automating manual data entry processes with Python scripts, saving the operations team 12 hours weekly.

## Skills
- **Languages:** JavaScript (ES6+), TypeScript, Python, HTML5, CSS3, SQL
- **Frameworks:** React.js, Node.js, Express, Next.js, Bootstrap, Tailwind CSS
- **Tools:** Git, Docker, AWS (EC2, S3), Jira, Webpack, Jenkins
- **Database:** MongoDB, PostgreSQL, Redis

## Education
### Bachelor of Science in Computer Science
University of Technology | 2017 - 2021
- GPA: 3.8/4.0
- Relevant Coursework: Data Structures, Algorithms, Distributed Systems

## Projects
### E-Commerce Platform
- Built a fully functional e-commerce platform supporting 10k+ daily users.
- implemented JWT authentication and role-based access control.
- Designed RESTful APIs for product management and order processing.
        `.trim();

    return {
      optimizedCV: mockOptimizedCV,
      coverLetter: `
Dear Hiring Manager,

I am writing to express my strong interest in the open position. With my background in software engineering and track record of delivering high-quality web applications, I am confident in my ability to contribute effectively to your team.

My experience at TechSolutions Inc. has focused heavily on modernizing legacy systems and improving performance, skills that directly align with your job description. I am eager to bring my technical expertise and problem-solving abilities to your organization.

Thank you for your time and consideration.

Sincerely,
Alexander James
            `.trim(),
    };
  }

  try {
    console.log("Beginning Parallel Generation: CV & Cover Letter...");
    const [cvResult, clResult] = await Promise.all([
      generateCV(resumeText, jobDescription || "General Professional Role"),
      jobDescription ? generateCoverLetter(resumeText, jobDescription) : Promise.resolve(null),
    ]);

    console.log("Parallel Generation Complete.");

    return {
      optimizedCV: cvResult,
      coverLetter: clResult,
    };
  } catch (error) {
    console.error("AI Generation Failed", error);
    return {
      optimizedCV: "Error generating content.",
      coverLetter: "Error generating content.",
    };
  }
};

const generateCV = async (resumeText, jobDescription) => {
  const prompt = `
    You are an ATS-optimization engine for ApplyRight.
    Your job is to convert unstructured user career data into a clean, ATS-compliant CV using a strict pipeline.

    INPUT DATA:
    ${jobDescription ? `JOB DESCRIPTION:\n    ${smartTruncate(jobDescription, 16000)}` : "TARGET ROLE: General Professional Role (Optimize for general readability and impact)"}

    USER RESUME:
    ${smartTruncate(resumeText, 16000)}

    TASK:
    Apply the following process exactly:

    Step 1 — Extract
    Identify: name, contact info, roles, employers, dates, skills, education, projects.

    Step 2 — Normalize
    Step 2 — Normalize
    - Generate a Professional Summary by analyzing the candidate's Work History and Skills. Highlight key achievements and relevance to the Job Description.
      * IMPORTANT: Use the candidate's *actual* recent job titles from Work History (e.g. "Wireline Operator"). Do NOT "upgrade" or change titles (e.g. to "Engineer") unless the evidence is explicit.
      * Write a single, cohesive paragraph (no bullets).
    - Convert job descriptions into achievement-oriented bullet points (Action + Task + Result).
    - Standardize job titles and dates.

    Step 3 — ATS Optimization
    - Use industry-standard keywords inferred from the user’s background${jobDescription ? " and Job Description" : ""}.
    - Avoid buzzwords and personal pronouns (I, me, my).
    - Keep language factual and concise.

    Step 4 — Section Mapping
    Map all content strictly into these sections (use exactly these headers):
    - ## Professional Summary
    - ## Work History
    - ## Skills
    - ## Education
    - ## Projects

    Step 5 — Output Format
    1. START WITH: "# [Full Name in CAPS]" as the very first line.
    2. Follow with "## Professional Summary" as a paragraph.
    3. For "## Work History", use sub-headers "### [Job Title]" followed by "[Company Name] | [Dates]" on the next line, then bullet points.
    4. For "## Skills", use bullet points. GROUP SKILLS DYNAMICALLY based on the candidate's specific domain.
       - Example for Dev: "- **Frontend:** React, CSS... \\n - **Backend:** Node, SQL..."
       - Example for Nurse: "- **Clinical Care:** Triage, Phlebotomy... \\n - **Compliance:** HIPAA, OSHA..."
       - Example for Sales: "- **CRM Tools:** Salesforce, HubSpot... \\n - **Strategies:** Lead Gen, Closing..."
       - DO NOT use generic "Technical/Soft Skills" headers unless absolutely necessary. Infer the best professional categories.
    5. For "## Education", use sub-headers "### [Degree]" followed by "[Institution] | [Dates]" and bullet points (e.g., GPA or Honors).
    6. For "## Projects", use sub-headers "### [Project Name]" followed by bullet points.
    
    IMPORTANT: Return ONLY the markdown string of the CV. Do NOT return JSON. Do NOT wrap in code blocks. Just the raw markdown text.
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    // Cleanup potential markdown wrappers
    return resultText
      .replace(/^```markdown\n/, "")
      .replace(/^```\n/, "")
      .replace(/\n```$/, "")
      .trim();
  } catch (e) {
    console.error("CV Generation Error:", e);
    return "# Error Generating CV\nPlease try again.";
  }
};

/**
 * Enhanced CV Content Generation (Stage 3 of CV Optimizer Pipeline)
 *
 * One structured AI call that enhances content per-section with strict rules:
 * - IMMUTABLE: job titles, company names, dates, school names, degrees
 * - ENHANCED: professional summary, bullet points, project descriptions
 * - MODERATE: can infer obvious skills from context, cannot invent achievements
 *
 * @param {object} params
 * @param {object} params.candidateData - Extracted candidate profile
 * @param {object} params.jobData - Extracted job requirements
 * @param {object[]} params.rankedExperiences - Relevance-scored experiences
 * @param {object[]} params.rankedProjects - Relevance-scored projects
 * @param {string[]} params.missingKeywords - JD keywords not found in resume
 * @returns {object} Enhanced content: { professionalSummary, experience[], projects[], skills[] }
 */
const enhanceCVContent = async ({
  candidateData,
  jobData,
  rankedExperiences,
  rankedProjects,
  missingKeywords,
}) => {
  if (activeProvider === "mock") {
    return {
      professionalSummary:
        "Results-oriented professional with experience in relevant technologies. Proven track record of delivering quality solutions.",
      experience: rankedExperiences.map((exp) => ({
        title: exp.role || exp.title,
        company: exp.company,
        startDate: exp.startDate,
        endDate: exp.endDate,
        bullets: Array.isArray(exp.description)
          ? exp.description
          : [exp.description || "Contributed to team projects."],
      })),
      projects: rankedProjects.map((proj) => ({
        title: proj.title,
        link: proj.link,
        bullets: Array.isArray(proj.description)
          ? proj.description
          : [proj.description || "Built a project."],
      })),
      skills: candidateData.skills || [],
    };
  }

  // Build experience context for AI
  const experienceContext = rankedExperiences
    .map(
      (exp, i) =>
        `ROLE_${i + 1}:
  Title (IMMUTABLE): "${exp.role || exp.title}"
  Company (IMMUTABLE): "${exp.company}"
  Start Date (IMMUTABLE): "${exp.startDate}"
  End Date (IMMUTABLE): "${exp.endDate}"
  Relevance Score: ${exp.relevanceScore}/100
  Target Bullets: ${exp.targetBulletCount}
  Original Content: "${Array.isArray(exp.description) ? exp.description.join("; ") : exp.description || "No details provided"}"`
    )
    .join("\n\n");

  const projectContext = rankedProjects
    .map(
      (proj, i) =>
        `PROJECT_${i + 1}:
  Title (IMMUTABLE): "${proj.title}"
  Link (IMMUTABLE): "${proj.link || "none"}"
  Original Content: "${Array.isArray(proj.description) ? proj.description.join("; ") : proj.description || "No details provided"}"`
    )
    .join("\n\n");

  const prompt = `
You are an expert Resume Optimizer. Your task is to enhance CV content for a specific job application.

TARGET JOB: ${jobData.detectedJobTitle || "Professional Role"} at ${jobData.detectedCompany || "Target Company"}

KEY JOB REQUIREMENTS:
- Must-have skills: ${(jobData.requiredSkills || []).map((s) => s.name).join(", ") || "None specified"}
- Preferred skills: ${(jobData.preferredSkills || []).map((s) => s.name).join(", ") || "None specified"}
- Experience: ${jobData.requiredYearsExperience || 0}+ years
- Level: ${jobData.seniorityLevel || "mid"}

CANDIDATE PROFILE:
- Skills: ${(candidateData.skills || []).join(", ")}
- Total Experience: ${candidateData.totalYearsExperience || 0} years
- Level: ${candidateData.seniorityLevel || "mid"}

MISSING KEYWORDS (try to naturally incorporate where truthful):
${missingKeywords.map((k) => k.name).join(", ") || "None"}

═══ STRICT RULES ═══
1. IMMUTABLE FIELDS: You MUST NOT change job titles, company names, dates, school names, or degrees. Copy them exactly as provided.
2. NO FABRICATION: Do NOT invent achievements, metrics, or claims not supported by the original content. If original says "managed database", you may say "Administered and maintained database systems" but NOT "Managed database serving 10,000 users" unless that detail exists.
3. MODERATE INFERENCE: You MAY infer obvious related skills (e.g., if they used React, you can mention JavaScript/frontend development). You MAY reword descriptions to be more achievement-oriented.
4. KEYWORD INTEGRATION: Where truthful, weave missing keywords into descriptions naturally. Do NOT force irrelevant keywords into unrelated roles.
5. BULLET FORMAT: Each bullet should start with a strong action verb. Use "Action + Context + Result" format where possible. Keep each bullet under 120 characters.
6. AUTHORITY MATCHING: Match bullet point authority to role seniority:
   - Junior/Entry: "Executed", "Supported", "Assisted", "Performed"
   - Mid: "Developed", "Implemented", "Managed", "Analyzed"
   - Senior/Lead: "Led", "Designed", "Architected", "Mentored"

═══ WORK EXPERIENCE ═══
${experienceContext || "No experience provided"}

═══ PROJECTS ═══
${projectContext || "No projects provided"}

═══ CANDIDATE SUMMARY (to base professional summary on) ═══
${candidateData.summary || "No summary available"}

═══ OUTPUT FORMAT ═══
Return STRICT JSON only. No markdown code blocks. No extra text.
{
  "professionalSummary": "A compelling 3-4 sentence professional summary. Use candidate's ACTUAL most recent job title. Highlight real skills and experience relevant to the target job. Do NOT upgrade titles.",
  "experience": [
    {
      "title": "EXACT ORIGINAL TITLE — DO NOT CHANGE",
      "company": "EXACT ORIGINAL COMPANY — DO NOT CHANGE",
      "startDate": "EXACT ORIGINAL — DO NOT CHANGE",
      "endDate": "EXACT ORIGINAL — DO NOT CHANGE",
      "bullets": ["Enhanced bullet 1", "Enhanced bullet 2", "..."]
    }
  ],
  "projects": [
    {
      "title": "EXACT ORIGINAL TITLE — DO NOT CHANGE",
      "link": "EXACT ORIGINAL — DO NOT CHANGE",
      "bullets": ["Enhanced bullet 1", "Enhanced bullet 2", "Enhanced bullet 3"]
    }
  ],
  "skills": ["Skill1", "Skill2", "..."]
}

IMPORTANT:
- Return ALL roles from WORK EXPERIENCE in the same order provided.
- Return ALL projects in the same order provided.

═══ SKILLS INFERENCE RULES ═══
For the "skills" array, you MUST:
1. Start with ALL skills the candidate explicitly lists or mentions.
2. INFER additional skills that are clearly implied by their work. Examples of valid inference:
   - Used React → infer "JavaScript", "HTML", "CSS", "Frontend Development"
   - Built REST APIs → infer "API Development", "HTTP"
   - Managed a team → infer "Team Leadership", "Mentoring"
   - Used Git → infer "Version Control"
   - Deployed to AWS → infer "Cloud Computing"
   - Wrote unit tests → infer "Testing", "Quality Assurance"
3. Include skills from the MISSING KEYWORDS list IF the candidate's experience supports them (even loosely).
4. Do NOT add skills the candidate clearly has zero connection to.
5. AIM for 20-30 total skills. More is better than fewer — a rich skills section helps ATS matching.
`;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    const enhanced = JSON.parse(jsonStr);

    // SAFETY: Enforce immutable fields — override AI output with originals
    if (enhanced.experience) {
      enhanced.experience = enhanced.experience.map((exp, i) => {
        const original = rankedExperiences[i];
        if (original) {
          exp.title = original.role || original.title || exp.title;
          exp.company = original.company || exp.company;
          exp.startDate = original.startDate || exp.startDate;
          exp.endDate = original.endDate || exp.endDate;
        }
        return exp;
      });
    }

    if (enhanced.projects) {
      enhanced.projects = enhanced.projects.map((proj, i) => {
        const original = rankedProjects[i];
        if (original) {
          proj.title = original.title || proj.title;
          proj.link = original.link || proj.link;
        }
        return proj;
      });
    }

    return enhanced;
  } catch (error) {
    console.error("CV Enhancement AI call failed:", error);
    // Fallback: return original data with minimal formatting
    return {
      professionalSummary: candidateData.summary || "",
      experience: rankedExperiences.map((exp) => ({
        title: exp.role || exp.title,
        company: exp.company,
        startDate: exp.startDate,
        endDate: exp.endDate,
        bullets: Array.isArray(exp.description) ? exp.description : [exp.description || ""],
      })),
      projects: rankedProjects.map((proj) => ({
        title: proj.title,
        link: proj.link,
        bullets: Array.isArray(proj.description) ? proj.description : [proj.description || ""],
      })),
      skills: candidateData.skills || [],
    };
  }
};

const generateCoverLetter = async (resumeText, jobDescription) => {
  const prompt = `
    You are an expert Career Coach.
    Write a tailored, persuasive Cover Letter for this candidate applying to this job.

    JOB DESCRIPTION:
    ${smartTruncate(jobDescription, 12000)}

    USER RESUME:
    ${smartTruncate(resumeText, 12000)}

    INSTRUCTIONS:
    1. Tone: Professional, confident, and enthusiastic.
    2. Structure:
       - Salutation (Dear Hiring Manager, - or specific name if found in JD)
       - Hook: Opening paragraph stating interest and a high-level match value proposition.
       - Body: 1-2 paragraphs connecting specific past achievements (from resume) to the job requirements.
    3. CRITICAL ANTI-HALLUCINATION RULES:
       - **STRICTLY ADHERE TO FACTS:** Do NOT invent experiences, roles, or responsibilities that are not explicitly present in the USER RESUME.
       - **DO NOT** claim the candidate performed tasks (e.g., "managed social media") if their resume only lists unrelated roles (e.g., "Field Operator").
       - **TRANSFERABLE SKILLS:** If the candidate's past experience does not directly match the technical requirements, focus purely on TRANSFERABLE SOFT SKILLS (e.g., "leadership," "adaptability," "project management," "operational discipline") and how those translate to the new role.
       - It is better to sound "eager to learn" than to lie about experience.
    4. Closing: Reiterate interest and call to action.
    5. Sign-off (Sincerely, [Name]) - Infer name from resume.
    6. Keep it concise (strictly under 2000 characters).

    IMPORTANT: Return ONLY the raw text/markdown of the letter. Do NOT return JSON. Do NOT wrap in code blocks.
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    return resultText
      .replace(/^```markdown\n/, "")
      .replace(/^```\n/, "")
      .replace(/\n```$/, "")
      .trim();
  } catch (e) {
    console.error("Cover Letter Generation Error:", e);
    return "Error generating cover letter. Please try again.";
  }
};

const mockAnalysis = () => {
  return {
    detectedJobTitle: "Software Engineer",
    detectedCompany: "Mock Company",
    matchedSkills: [
      { name: "JavaScript", importance: "must_have" },
      { name: "React", importance: "must_have" },
    ],
    missingSkills: [
      { name: "AI API Key", importance: "must_have" },
    ],
    experienceAnalysis: {
      candidateYears: 1,
      requiredYears: 3,
      match: false,
      feedback: "Less than preferred experience.",
    },
    seniorityAnalysis: {
      candidateLevel: "entry",
      requiredLevel: "mid",
      match: false,
      feedback: "Candidate is one level below the required seniority.",
    },
    scoreBreakdown: {
      skillsScore: 67,
      experienceScore: 33,
      seniorityScore: 60,
    },
    fitScore: 50,
    overallFeedback: "Analysis performed in Mock/Offline Mode. Add an API key for real analysis.",
    recommendation: "Add an API Key to enable AI analysis.",
    actionPlan: [
      {
        skill: "AI API Key",
        importance: "must_have",
        action: "Sign up for OpenAI or Google Gemini and add the key to .env",
      },
    ],
    mode: "Standard",
    provider: "local",
  };
};

const generateInterviewQuestions = async (jobDescription, userSkills) => {
  if (activeProvider === "mock") {
    return mockInterviewQuestions(jobDescription);
  }

  const prompt = `
    You are an expert Interview Coach and Technical Hiring Manager.
    Generate a set of interview questions and questions for the candidate to ask, based SPECIFICALLY on the Job Description provided.

    JOB DESCRIPTION:
    ${smartTruncate(jobDescription, 10000)}

    INSTRUCTIONS:
    1. Generate 3 "Questions to Answer" that the interviewer might ask the candidate.
       - Mix of specific TECHNICAL questions (based on tools/skills in JD) and BEHAVIORAL questions (based on soft skills in JD).
       - Label the type as 'technical', 'behavioral', or 'situational'.
    2. Generate 3 "Questions to Ask" that the candidate should ask the interviewer to demonstrate deep interest and insight.
       - These should be specific to the company/role if possible, or strategic general questions.

    Output STRICT JSON format:
    {
        "questionsToAnswer": [
            { "type": "technical", "question": "..." },
            { "type": "behavioral", "question": "..." },
            { "type": "situational", "question": "..." }
        ],
        "questionsToAsk": [
            "...",
            "...",
            "..."
        ]
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    // Clean up markdown code blocks if AI adds them
    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    // Helper to extract JSON if it's wrapped in other text
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Interview Generation Failed, falling back to mock:", error);
    return mockInterviewQuestions(jobDescription);
  }
};

const mockInterviewQuestions = (jobDescription) => {
  // Heuristics based on keywords in the JD
  const questions = [
    {
      type: "behavioral",
      question: "Tell me about a time you handled a difficult stakeholder.",
    },
    {
      type: "behavioral",
      question: "Describe a situation where you had to learn a new tool quickly.",
    },
  ];

  const techKeywords = [
    "react",
    "node",
    "sql",
    "python",
    "aws",
    "docker",
    "java",
    "communication",
    "sales",
    "marketing",
  ];
  const lowerJD = jobDescription.toLowerCase();

  techKeywords.forEach((tech) => {
    if (lowerJD.includes(tech)) {
      questions.push({
        type: "technical",
        question: `Explain how you have used ${tech} in a recent project. What challenges did you face?`,
      });
    }
  });

  const questionsToAsk = [
    "What does success look like in this role for the first 90 days?",
    "Can you describe the team culture and how you collaborate?",
    "What are the biggest challenges the team is currently facing?",
  ];

  if (lowerJD.includes("agile") || lowerJD.includes("scrum")) {
    questionsToAsk.push("How does your team practice Agile/Scrum day-to-day?");
  }
  if (lowerJD.includes("leadership") || lowerJD.includes("manage")) {
    questionsToAsk.push("How does your team practice Agile/Scrum day-to-day?");
  }
  if (lowerJD.includes("remote") || lowerJD.includes("hybrid")) {
    questionsToAsk.push("How does the team maintain communication in a remote/hybrid setting?");
  }

  return {
    questionsToAnswer: questions.slice(0, 3),
    questionsToAsk: questionsToAsk.slice(0, 3),
  };
};

const extractResumeProfile = async (resumeText) => {
  if (activeProvider === "mock") {
    return mockResumeExtraction();
  }

  const prompt = `
    You are an expert Resume Parser.
    Extract structured data from the following resume text.

    RESUME TEXT:
    ${smartTruncate(resumeText, 16000)}

    INSTRUCTIONS:
    1. Extract SKILLS as an array of strings.
    2. Extract EXPERIENCE as an array of objects: { "role": "...", "company": "...", "startDate": "...", "endDate": "...", "description": "array of strings (REWRITE into strong, achievement-oriented bullet points using action verbs)" }.
    3. Extract EDUCATION as an array of objects: { "degree": "...", "field": "...", "school": "...", "date": "..." }.
    4. Extract PROJECTS as an array of objects: { "title": "...", "link": "...", "description": "array of strings (bullet points)" }.
       - IMPORTANT: "link" should be NULL if no valid URL (http/www) is found. Do NOT use the project title as the link.
    5. Estimate SENIORITY level: 'entry', 'mid', 'senior', or 'executive'.
    6. Generate a PROFESSIONAL SUMMARY (string). Write a compelling, ATS-optimized summary (3-4 sentences) based on the resume's history and skills. Do not just copy the existing one if it's weak.

    Output STRICT JSON format only:
    {
        "skills": ["..."],
        "experience": [{ "role": "...", "company": "...", "startDate": "...", "endDate": "...", "description": [...] }],
        "education": [{ "degree": "...", "field": "...", "school": "...", "date": "..." }],
        "projects": [{ "title": "...", "link": "...", "description": [...] }],
        "seniority": "...",
        "summary": "..."
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Resume Extraction Failed:", error);
    return mockResumeExtraction();
  }
};

const generateBulletPoints = async (role, context, type = "experience", targetJob = "") => {
  if (activeProvider === "mock") {
    return ["Developed a feature using React.", "Optimized backend performance."];
  }

  // Customize prompt based on type
  let prompt = "";

  if (type === "summary") {
    prompt = `
        You are an expert Resume Writer.
        Write a powerful, professional summary for a CV (Resume) based on the candidate's background.

        INPUT DATA:
        Role/Title: ${role}
        Details: ${context}
        Target Job Context: ${targetJob ? targetJob.substring(0, 500) : "General Professional Role"}

        INSTRUCTIONS:
        1. Write a SINGLE, cohesive paragraph (3-4 sentences max).
        2. Do NOT use bullet points.
        3. Structure:
           - Start with a strong professional identity. IMPORTANT: Use the candidate's *actual* recent job title from their Work History (e.g. "Experienced Wireline Operator"). Do NOT "upgrade" titles (e.g. do not change "Operator" to "Engineer") unless the evidence is explicit.
           - Mention key achievements and industries found in the "Work History Summary".
           - weave in the "Key Skills" naturally.
           - Align gently with the "Target Job Description" keywords if provided.
        4. Tone: Professional, confident, and factual.
        5. AVOID generic fluff like "hard worker" or "team player". Focus on tangible value.
        
        Output STRICT JSON:
        {
            "suggestions": ["<The entire summary paragraph string>"]
        }
        `;
  } else if (type === "project") {
    const projectTitle = role || "Project";
    prompt = `
You are an expert Resume Writer.

Your task is to rewrite 3 ATS-optimized bullet points for a PROJECT.
Accuracy and factual integrity are more important than sounding impressive.

INPUT:
Project Title: "${projectTitle}"
Project Context / Existing Notes: "${context}"

RULES:
1. Preserve facts. Do NOT add new tools, metrics, users, business outcomes, or claims not in the input.
2. If metrics are not provided, use qualitative impact without numbers.
3. Keep scope at project level; avoid company-wide or organizational claims.
4. Prefer action verbs and technical specificity only when provided.
5. If the context is thin, keep bullets general and credible rather than speculative.
6. Ignore any target job description completely.

SUGGESTED CONTENT MIX:
- Bullet 1: Goal/problem the project addressed.
- Bullet 2: Implementation/approach and key technologies (only if mentioned).
- Bullet 3: Outcome, quality improvement, or learning (non-inflated).

OUTPUT STRICT JSON ONLY:
{
  "suggestions": [
    "Bullet 1",
    "Bullet 2",
    "Bullet 3"
  ]
}
`;
  } else {
    // IMPROVED PROMPT FOR WORK HISTORY BULLETS
    // User Requirement: "It shouldn't look at the Target Job Description... it should look at the company and what the role is for the company"
    prompt = `
You are an expert Resume Writer and Recruiter.

Your task is to generate 6 realistic, ATS-optimized bullet points for a specific work history role.
Accuracy and role realism are more important than sounding impressive. Imagine you are chatting with a user to uncover real, grounded achievements—avoid overly exaggerated claims ("too much") and generic fluff ("too little").

INPUT:
Job Title: "${role}"
Context / Company Information: "${context}"

MANDATORY REASONING STEPS (DO NOT SKIP):

STEP 1: Infer Industry & Function
- Infer the industry from the company name or context.
- Infer the functional role from the job title.
- Example: "Field Operator" ≠ "Field Engineer" ≠ "Manager"

STEP 2: Determine Role Authority Level
Classify the role into ONE category:

• EXECUTION-LEVEL
  (Operator, Technician, Assistant, Intern, Junior roles)
  - Executes tasks
  - Follows defined procedures
  - Supports delivery

• SPECIALIST-LEVEL
  (Engineer, Analyst, Developer, Designer, Accountant)
  - Applies expertise
  - Solves defined technical problems
  - Improves local workflows (not company-wide)

• OWNERSHIP-LEVEL
  (Senior, Lead, Principal, Manager, Head)
  - Owns systems or outcomes
  - Defines processes
  - Drives measurable business impact

STEP 3: Enforce Role Scope (CRITICAL)
- Bullet points MUST stay within the authority of the classified level.
- DO NOT assign:
  - Strategic ownership
  - System or process design
  - Company-wide optimization
  - Cost-saving claims
UNLESS the role is OWNERSHIP-LEVEL.

STEP 4: Generate 6 Varied Options
Create 6 distinct bullet points covering different aspects of the job. For example:
  1. Technical Execution or Daily Operations
  2. Collaboration or Teamwork
  3. Problem Solving or Troubleshooting
  4. Process Adherence or Efficiency
  5. Tools / Software / Equipment usage
  6. Client / Stakeholder interaction (if applicable) or Quality Assurance

GENERATION RULES:
1. Ignore any future or target job description completely.
2. Avoid generic phrases ("Worked on", "Helped with").
3. Use strong but role-appropriate action verbs.
   - EXECUTION: Executed, Performed, Monitored, Operated, Supported
   - SPECIALIST: Analyzed, Implemented, Configured, Validated, Improved
   - OWNERSHIP: Led, Designed, Optimized, Defined, Owned
4. Be "real" - use plausible impact and scope matching the inferred seniority of the role.
5. If user context lacks specifics, generate typical but believable, grounded duties.
6. Do NOT exaggerate authority, impact, or use inflated metrics.

OUTPUT STRICT JSON ONLY:
{
  "suggestions": [
    "Bullet 1 text...",
    "Bullet 2 text...",
    "Bullet 3 text...",
    "Bullet 4 text...",
    "Bullet 5 text...",
    "Bullet 6 text..."
  ]
}
`;
  }

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    const data = JSON.parse(jsonStr);
    return data.suggestions || [];
  } catch (error) {
    console.error("AI Bullet Generation Failed:", error);
    return ["Error generating bullets. Please try again."];
  }
};

const generateSkillsFromContext = async (education, experience, projects, targetJob = "") => {
  if (activeProvider === "mock") {
    return mockSkillsGeneration();
  }

  const educationText = education
    .map((e) => `${e.degree} in ${e.field} from ${e.school}`)
    .join("; ");
  const experienceText = experience
    .map((e) => `${e.title} at ${e.company}: ${e.description}`)
    .join("\n");
  const projectsText = projects.map((p) => `${p.title}: ${p.description}`).join("\n");

  const prompt = `
    You are an expert Career Coach and Technical Recruiter.
    Analyze the following candidate profile and extract a comprehensive list of relevant skills.
    Group these skills into logical professional categories.

    CANDIDATE PROFILE:
    Education: ${educationText}
    Work Experience: ${experienceText}
    Projects: ${projectsText}
    ${targetJob ? `Target Job Context: ${targetJob}` : ""}

    INSTRUCTIONS:
    1. Extract hard skills (technologies, tools, languages) and soft skills (leadership, communication).
    2. Group them into 4-6 specific categories (e.g., "Programming Languages", "Project Management", "Industry Knowledge", "Soft Skills").
    3. Avoid "General" or "Other" if possible. Be specific.
    4. Limit to 20-30 most impactful skills total.

    OUTPUT STRICT JSON:
    {
        "suggestions": [
            { "category": "Category Name", "skills": ["Skill 1", "Skill 2"] },
            { "category": "Another Category", "skills": ["Skill A", "Skill B"] }
        ]
    }
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    const data = JSON.parse(jsonStr);
    return data.suggestions || [];
  } catch (error) {
    console.error("AI Skills Generation Failed:", error);
    return mockSkillsGeneration();
  }
};

const mockSkillsGeneration = () => {
  return [
    {
      category: "Web Development",
      skills: ["React", "Node.js", "Tailwind CSS", "MongoDB"],
    },
    { category: "Tools & DevOps", skills: ["Git", "Docker", "VS Code"] },
    {
      category: "Soft Skills",
      skills: ["Team Leadership", "Communication", "Problem Solving"],
    },
  ];
};

const mockResumeExtraction = () => {
  return {
    skills: ["Mock Skill 1", "Mock Skill 2"],
    experience: [
      {
        role: "Mock Role",
        company: "Mock Co",
        startDate: "Jan 2023",
        endDate: "Present",
        description: ["Mock bullet 1", "Mock bullet 2"],
      },
    ],
    education: [{ degree: "BS", field: "CS", school: "Mock Univ", date: "2022" }],
    projects: [
      {
        title: "Mock Project",
        link: "http://example.com",
        description: ["Built a cool thing"],
      },
    ],
    seniority: "entry",
    summary: "This is a mock professional summary for testing purposes.",
  };
};

/**
 * Generate categorized skills based on profile context (Structured for DB)
 */
const generateStructuredSkills = async (contextData) => {
  const { education, experience, projects, targetJob } = contextData;

  const prompt = `
    Based on the following candidate profile and target job (if provided), suggest a list of relevant professional skills.
    Categorize them into logical groups (e.g., Technical Skills, Soft Skills, Tools, Languages, etc.).

    CANDIDATE PROFILE:
    - Education: ${JSON.stringify(education)}
    - Experience: ${JSON.stringify(experience)}
    - Projects: ${JSON.stringify(projects)}

    TARGET JOB: ${targetJob ? JSON.stringify(targetJob) : "General Professional Role"}

    TASK:
    1. Extract 10-15 relevant skills.
    2. Categorize them.
    3. Return ONLY a JSON array of objects with 'name' and 'category'.

    Example JSON structure:
    [
        { "name": "React.js", "category": "Technical Skills" },
        { "name": "Project Management", "category": "Soft Skills" }
    ]
    `;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    } else {
      // Mock Fallback
      return [
        { name: "Communication", category: "Soft Skills" },
        { name: "Team Leadership", category: "Soft Skills" },
        { name: "Problem Solving", category: "Soft Skills" },
        { name: "JavaScript", category: "Technical Skills" },
        { name: "React", category: "Technical Skills" },
      ];
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("[");
    const endIndex = jsonStr.lastIndexOf("]");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Skills Generation Failed:", error);
    return [];
  }
};

/**
 * Categorize an explicit list of skills into professional groups.
 * Unlike generateStructuredSkills (which extracts from profile), this takes
 * a pre-built list and just organizes it.
 *
 * Also handles deduplication (e.g., "REST APIs" and "RESTful APIs" → keep one).
 *
 * @param {string[]} skillsList - All skills to categorize
 * @param {string} targetJobTitle - Target role for context
 * @returns {Array<{ name: string, category: string }>}
 */
const categorizeSkillsList = async (skillsList, targetJobTitle = "") => {
  if (!skillsList || skillsList.length === 0) return [];

  if (activeProvider === "mock") {
    return skillsList.map((s) => ({ name: s, category: "Technical Skills" }));
  }

  const prompt = `
You are an expert Resume Skills Organizer who works across ALL industries and professions.

You are given a list of professional skills. Your job is to:

1. DEDUPLICATE — merge obvious duplicates and synonyms into one clean entry. Examples:
   - "REST APIs" + "RESTful APIs" → keep "REST APIs"
   - "Git" + "Git & GitHub" → keep "Git & GitHub"
   - "Problem-solving" + "Problem Solving" → keep "Problem Solving"
   - Remove meta-labels that aren't real skills (e.g., "Full-stack Development" when specific frontend + backend skills already exist, or "Web Development" when HTML/CSS/JS are listed).

2. CATEGORIZE — group each skill into a specific, domain-appropriate category.
   - INFER categories from the skills themselves and the target role. Do NOT use a fixed list.
   - Use 4-7 categories. Each category MUST have at least 2 skills. If a skill would be alone in a category, merge it into a related one.
   - Category names should be SHORT (2-3 words max) and specific to the profession.
   - BAD (too generic): "Technical Skills", "Other", "General", "Miscellaneous", "Hard Skills"
   - The right categories depend entirely on the profession — a nurse, a developer, a chef, and an accountant should all get completely different category names.
   - SOFT SKILLS RULE: All interpersonal and transferable skills (e.g., Leadership, Communication, Problem Solving, Teamwork, Time Management, Critical Thinking, Creativity, Attention to Detail, Adaptability, Conflict Resolution, etc.) MUST be grouped together under ONE category called "Soft Skills". Never scatter them across other categories or create separate categories for each.

3. ORDER — within each category, most relevant skills to the target role come first.

4. KEEP ALL SKILLS — include every unique skill after deduplication. Do NOT drop skills. Only trim if there are 30+ skills, and never below 20.

SKILLS TO ORGANIZE:
${skillsList.join(", ")}

TARGET ROLE: ${targetJobTitle || "Professional Role"}

Return STRICT JSON array only. No markdown code blocks. No extra text.
[
  { "name": "Skill Name", "category": "Category Name" }
]
`;

  try {
    let resultText = "";
    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("[");
    const endIndex = jsonStr.lastIndexOf("]");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Skills Categorization Failed:", error);
    // Fallback: return uncategorized
    return skillsList.slice(0, 25).map((s) => ({
      name: s,
      category: "Skills",
    }));
  }
};

/**
 * Extract job title, company, and location from raw job description text.
 * Lightweight AI call used when users paste text or when scraper returns weak metadata.
 */
const extractJobMetadata = async (descriptionText) => {
  if (activeProvider === "mock") {
    return {
      title: "Job Application",
      company: "Unknown Company",
      location: null,
    };
  }

  const prompt = `
    You are a job posting parser. Extract ONLY the factual metadata from this job posting text.

    JOB POSTING TEXT:
    ${smartTruncate(descriptionText, 10000)}

    INSTRUCTIONS:
    1. "title": The specific job title/role being advertised (e.g., "Senior Software Engineer", "Marketing Manager"). Look for the main heading, "Position:", "Role:", "Job Title:" labels, or the most prominent role mentioned. Do NOT include the company name in the title.
    2. "company": The name of the hiring company/organization. Ignore recruitment agencies, job boards, or platforms (e.g., ignore "Jobberman", "LinkedIn", "Indeed"). Look for "Company:", "About Us", "About [Company]", or the employer name in context. If genuinely not found, use null.
    3. "location": The job location if mentioned (city, state, country, or "Remote"). If not found, use null.

    Return STRICT JSON only. No markdown, no code blocks:
    {
        "title": "<extracted_job_title>",
        "company": "<extracted_company_or_null>",
        "location": "<extracted_location_or_null>"
    }
    `;

  try {
    let resultText = "";

    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    let jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const startIndex = jsonStr.indexOf("{");
    const endIndex = jsonStr.lastIndexOf("}");
    if (startIndex !== -1 && endIndex !== -1) {
      jsonStr = jsonStr.substring(startIndex, endIndex + 1);
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Job Metadata Extraction Failed:", error);
    return {
      title: null,
      company: null,
      location: null,
    };
  }
};

module.exports = {
  analyzeProfile,
  extractJobRequirements,
  extractCandidateData,
  generateAnalysisFeedback,
  enhanceCVContent,
  generateOptimizedContent,
  generateCV,
  generateCoverLetter,
  generateInterviewQuestions,
  extractResumeProfile,
  extractJobMetadata,
  generateBulletPoints,
  generateSkillsFromContext,
  generateStructuredSkills,
  categorizeSkillsList,
  activeProvider,
};
