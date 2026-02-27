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
  console.log(
    "   Reason: No API Keys found (OPENAI_API_KEY or GEMINI_API_KEY)",
  );
  console.log(
    "   Action: Falling back to Mock Mode. Real analysis will not work.\n",
  );
}

const analyzeProfile = async (resumeText, jobDescription) => {
  if (activeProvider === "mock") {
    return mockAnalysis();
  }

  const prompt = `
    You are an expert HR Recruiter and Technical Hiring Manager.
    Analyze the following Candidate Resume against the Job Description.

    JOB DESCRIPTION:
    ${jobDescription.substring(0, 2000)}

    RESUME:
    ${resumeText.substring(0, 2000)}

    EXTRACT METADATA (CRITICAL — use JOB DESCRIPTION section ONLY):
    - "detectedJobTitle": Extract the specific role being advertised in the JOB DESCRIPTION above. Do NOT use any role from the RESUME (the candidate's past titles are irrelevant here). Look for phrases like "We are hiring a...", "Position:", "Role:", or the main heading.
    - "detectedCompany": Extract the hiring company from the JOB DESCRIPTION above. Do NOT use any company from the RESUME. Ignore recruitment agencies (e.g., "Jobberman", "Work Link") and look for the actual employer.

    Output a JSON object ONLY. Do not output markdown code blocks. Structure:
    {
        "detectedJobTitle": "<role_from_JOB_DESCRIPTION_only>",
        "detectedCompany": "<company_from_JOB_DESCRIPTION_only>",
        "skills": ["matched_skill_1", "matched_skill_2"],
        "missingSkills": ["important_missing_skill"],
        "experienceYears": <integer_estimate_of_total_relevant_experience>,
        "seniority": "<one_of: entry, mid, senior, executive>",
        "experienceAnalysis": {
            "match": <boolean>,
            "feedback": "<short_string_e.g._Less_than_preferred_or_Meets_requirements>"
        },
        "seniorityAnalysis": {
            "match": <boolean>,
            "feedback": "<short_string_e.g._Aligned_with_role_or_Overqualified>"
        },
        "reasoning": "<short_sentence_explaining_seniority_and_fit>",
        "fitScore": <integer_0_to_100_based_on_overall_match>,
        "recommendation": "<short_advice_for_candidate>",
        "actionPlan": [
            { "skill": "missing_skill_1", "action": "Specific, actionable advice (e.g., Build a project using X...)" }
        ]
    }
    `;

  try {
    let resultText = "";

    if (activeProvider === "openai") {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo", // Cost effective
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2, // Low creativity for analysis
      });
      resultText = response.choices[0].message.content;
    } else if (activeProvider === "gemini") {
      const result = await geminiModel.generateContent(prompt);
      resultText = result.response.text();
    }

    // Clean up markdown code blocks if AI adds them
    const jsonStr = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    return {
      ...JSON.parse(jsonStr),
      mode: "AI",
      provider: activeProvider,
    };
  } catch (error) {
    console.error("AI Analysis Failed, falling back to mock:", error);
    return mockAnalysis();
  }
};

const generateOptimizedContent = async (
  resumeText,
  jobDescription,
  userContext = {},
) => {
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
      jobDescription
        ? generateCoverLetter(resumeText, jobDescription)
        : Promise.resolve(null),
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
    ${jobDescription ? `JOB DESCRIPTION:\n    ${jobDescription.substring(0, 8000)}` : "TARGET ROLE: General Professional Role (Optimize for general readability and impact)"}

    USER RESUME:
    ${resumeText.substring(0, 8000)}

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

const generateCoverLetter = async (resumeText, jobDescription) => {
  const prompt = `
    You are an expert Career Coach.
    Write a tailored, persuasive Cover Letter for this candidate applying to this job.

    JOB DESCRIPTION:
    ${jobDescription.substring(0, 5000)}

    USER RESUME:
    ${resumeText.substring(0, 5000)}

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
    skills: ["javascript", "react", "mock-skill"],
    missingSkills: ["real-ai-key"],
    experienceYears: 1,
    seniority: "entry",
    experienceAnalysis: {
      match: false,
      feedback: "Less than preferred",
    },
    seniorityAnalysis: {
      match: true,
      feedback: "Aligned with role",
    },
    reasoning: "Analysis performed in Mock/Offline Mode.",
    fitScore: 50,
    recommendation: "Add an API Key to enable AI analysis.",
    actionPlan: [
      {
        skill: "real-ai-key",
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
    ${jobDescription.substring(0, 5000)}

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
    console.error(
      "AI Interview Generation Failed, falling back to mock:",
      error,
    );
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
      question:
        "Describe a situation where you had to learn a new tool quickly.",
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
    questionsToAsk.push(
      "How does the team maintain communication in a remote/hybrid setting?",
    );
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
    ${resumeText.substring(0, 4000)}

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

const generateBulletPoints = async (
  role,
  context,
  type = "experience",
  targetJob = "",
) => {
  if (activeProvider === "mock") {
    return [
      "Developed a feature using React.",
      "Optimized backend performance.",
    ];
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

const generateSkillsFromContext = async (
  education,
  experience,
  projects,
  targetJob = "",
) => {
  if (activeProvider === "mock") {
    return mockSkillsGeneration();
  }

  const educationText = education
    .map((e) => `${e.degree} in ${e.field} from ${e.school}`)
    .join("; ");
  const experienceText = experience
    .map((e) => `${e.title} at ${e.company}: ${e.description}`)
    .join("\n");
  const projectsText = projects
    .map((p) => `${p.title}: ${p.description}`)
    .join("\n");

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
    education: [
      { degree: "BS", field: "CS", school: "Mock Univ", date: "2022" },
    ],
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

module.exports = {
  analyzeProfile,
  generateOptimizedContent,
  generateInterviewQuestions,
  extractResumeProfile,
  generateBulletPoints,
  generateSkillsFromContext,
  generateStructuredSkills,
  activeProvider,
};
