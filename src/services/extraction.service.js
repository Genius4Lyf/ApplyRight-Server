const extractionService = {
  // Comprehensive skills dictionary covering multiple industries
  skillsDictionary: [
    // ─── Technology / Software ───
    "javascript", "python", "java", "c++", "c#", "react", "node.js", "sql",
    "nosql", "mongodb", "aws", "azure", "gcp", "docker", "kubernetes",
    "git", "typescript", "angular", "vue.js", "html", "css", "php",
    "ruby", "go", "rust", "swift", "kotlin", "dart", "flutter",
    "react native", "next.js", "express.js", "django", "flask",
    "spring boot", ".net", "graphql", "rest api", "microservices",
    "ci/cd", "devops", "machine learning", "data science", "deep learning",
    "tensorflow", "pytorch", "nlp", "computer vision", "blockchain",
    "cybersecurity", "cloud computing", "saas", "api", "linux",
    "firebase", "redis", "elasticsearch", "postgresql", "mysql",
    "terraform", "ansible", "jenkins", "webpack", "figma",
    "responsive design", "seo", "wordpress", "shopify",

    // ─── Data & Analytics ───
    "tableau", "power bi", "excel", "data analysis", "data visualization",
    "data engineering", "etl", "data warehousing", "big data",
    "apache spark", "hadoop", "airflow", "kafka", "looker",
    "business intelligence", "statistical analysis", "predictive modeling",
    "data mining", "a/b testing", "google analytics", "r programming",
    "spss", "sas", "stata",

    // ─── Healthcare & Nursing ───
    "patient care", "clinical skills", "nursing", "registered nurse",
    "patient assessment", "medication administration", "vital signs",
    "wound care", "infection control", "cpr", "bls", "acls",
    "first aid", "triage", "health assessment", "pharmacology",
    "electronic health records", "ehr", "medical terminology",
    "clinical documentation", "patient education", "catheterization",
    "iv therapy", "blood pressure monitoring", "phlebotomy",
    "medical records", "hipaa", "patient safety", "bedside manner",
    "clinical rotation", "nursing care plan", "pediatric care",
    "geriatric care", "mental health", "psychiatric nursing",
    "surgical nursing", "emergency nursing", "midwifery",
    "obstetric care", "community health", "public health",
    "epidemiology", "health promotion", "disease prevention",
    "occupational therapy", "physical therapy", "physiotherapy",
    "speech therapy", "pharmacy", "dispensing", "drug interaction",
    "anatomy", "physiology", "pathology", "radiology",
    "laboratory skills", "specimen collection", "sterilization",
    "medical equipment", "ventilator management",

    // ─── Finance & Accounting ───
    "accounting", "bookkeeping", "financial analysis", "budgeting",
    "financial reporting", "auditing", "tax preparation", "tax compliance",
    "accounts payable", "accounts receivable", "payroll",
    "general ledger", "financial modeling", "forecasting",
    "risk management", "compliance", "regulatory compliance",
    "ifrs", "gaap", "quickbooks", "sage", "sap",
    "investment analysis", "portfolio management", "trading",
    "banking", "credit analysis", "loan processing",
    "anti-money laundering", "kyc", "insurance", "underwriting",
    "actuarial", "treasury management", "cost accounting",
    "management accounting", "internal controls", "reconciliation",

    // ─── Engineering (Non-Software) ───
    "autocad", "solidworks", "catia", "matlab", "project planning",
    "structural engineering", "civil engineering", "mechanical engineering",
    "electrical engineering", "chemical engineering", "process engineering",
    "quality control", "quality assurance", "lean manufacturing",
    "six sigma", "iso 9001", "cad", "3d modeling",
    "manufacturing", "production planning", "maintenance",
    "hvac", "plumbing", "welding", "surveying",
    "geotechnical", "environmental engineering", "safety engineering",
    "construction management", "quantity surveying", "bill of quantities",

    // ─── Sales & Marketing ───
    "sales", "business development", "lead generation",
    "customer acquisition", "account management", "crm",
    "salesforce", "hubspot", "cold calling", "negotiation",
    "digital marketing", "social media marketing", "content marketing",
    "email marketing", "seo", "sem", "google ads", "facebook ads",
    "copywriting", "brand management", "market research",
    "marketing strategy", "public relations", "event planning",
    "advertising", "media buying", "influencer marketing",
    "affiliate marketing", "conversion optimization", "analytics",

    // ─── Human Resources ───
    "recruitment", "talent acquisition", "onboarding",
    "employee relations", "performance management", "compensation",
    "benefits administration", "hr policy", "labor law",
    "workforce planning", "succession planning", "training",
    "learning and development", "organizational development",
    "employee engagement", "conflict resolution", "hris",
    "payroll management", "diversity and inclusion",

    // ─── Education & Training ───
    "teaching", "curriculum development", "lesson planning",
    "classroom management", "student assessment", "tutoring",
    "instructional design", "e-learning", "lms",
    "special education", "differentiated instruction",
    "educational technology", "early childhood education",
    "adult education", "literacy", "stem education",

    // ─── Legal ───
    "legal research", "contract drafting", "litigation",
    "corporate law", "intellectual property", "regulatory affairs",
    "due diligence", "legal compliance", "dispute resolution",
    "mediation", "arbitration", "conveyancing", "notarization",

    // ─── Logistics & Supply Chain ───
    "supply chain management", "procurement", "inventory management",
    "logistics", "warehouse management", "distribution",
    "fleet management", "import export", "customs clearance",
    "freight forwarding", "demand planning", "vendor management",
    "order fulfillment", "last mile delivery",

    // ─── Customer Service & Administration ───
    "customer service", "customer support", "help desk",
    "call center", "complaint resolution", "client relations",
    "administrative support", "office management", "scheduling",
    "data entry", "filing", "correspondence", "reception",
    "travel arrangement", "calendar management", "typing",
    "minute taking", "document management",

    // ─── Soft Skills ───
    "communication", "leadership", "teamwork", "problem solving",
    "critical thinking", "time management", "adaptability",
    "attention to detail", "organizational skills", "multitasking",
    "interpersonal skills", "decision making", "creativity",
    "presentation skills", "public speaking", "conflict management",
    "emotional intelligence", "mentoring", "coaching",
    "strategic thinking", "analytical skills", "collaboration",
    "initiative", "self-motivation", "work ethic",
    "customer focus", "results oriented", "flexibility",

    // ─── Project & Operations Management ───
    "project management", "agile", "scrum", "kanban",
    "waterfall", "prince2", "pmp", "stakeholder management",
    "change management", "process improvement", "operations management",
    "capacity planning", "resource allocation", "milestone tracking",
    "risk assessment", "business process", "kpi tracking",
    "lean", "continuous improvement",

    // ─── Media, Design & Creative ───
    "graphic design", "adobe photoshop", "adobe illustrator",
    "adobe indesign", "video editing", "photography",
    "content creation", "social media management", "canva",
    "ui/ux design", "user research", "wireframing", "prototyping",
    "motion graphics", "animation", "branding", "typography",
    "print design", "web design",

    // ─── Oil & Gas / Energy ───
    "hse", "health safety environment", "drilling", "well completion",
    "reservoir engineering", "pipeline", "refinery", "upstream",
    "downstream", "petrochemical", "safety management",
    "permit to work", "risk assessment", "environmental impact",
    "renewable energy", "solar energy", "wind energy",
  ],

  // Domain keywords mapped to categories for mismatch detection
  domainKeywords: {
    healthcare: ["nurse", "nursing", "clinical", "patient", "medical", "hospital", "health", "care", "pharmacy", "doctor", "physician", "therapist", "surgical", "icu", "ward", "diagnosis", "treatment", "midwife", "auxiliary"],
    technology: ["software", "developer", "engineer", "programming", "frontend", "backend", "fullstack", "full-stack", "devops", "cloud", "web", "mobile app", "database", "api", "code", "coding"],
    finance: ["accountant", "accounting", "finance", "financial", "auditor", "audit", "tax", "banking", "investment", "treasury", "bookkeep"],
    engineering: ["civil engineer", "mechanical engineer", "electrical engineer", "structural", "construction", "surveyor", "quantity survey", "autocad", "hvac"],
    education: ["teacher", "teaching", "lecturer", "instructor", "tutor", "professor", "education", "school", "curriculum"],
    legal: ["lawyer", "solicitor", "barrister", "legal", "law firm", "litigation", "paralegal", "attorney"],
    sales: ["sales", "business development", "account executive", "sales representative", "sales manager"],
    marketing: ["marketing", "brand", "digital marketing", "content", "seo specialist", "social media manager"],
    hr: ["human resources", "hr manager", "recruiter", "talent acquisition", "people operations"],
    logistics: ["logistics", "supply chain", "warehouse", "procurement", "fleet", "distribution"],
    creative: ["graphic design", "designer", "creative director", "art director", "photographer", "videographer"],
    oil_gas: ["oil", "gas", "drilling", "petroleum", "refinery", "hse officer", "pipeline", "upstream", "downstream"],
    customer_service: ["customer service", "call center", "support agent", "help desk", "client service"],
    admin: ["admin", "administrative", "receptionist", "office manager", "secretary", "personal assistant"],
  },

  seniorityKeywords: {
    entry: ["entry level", "entry-level", "junior", "associate", "intern", "trainee", "graduate trainee", "0-2 years", "0-1 year", "fresh graduate", "nysc"],
    mid: ["mid level", "mid-level", "mid-senior", "intermediate", "2-5 years", "3+ years", "2+ years"],
    senior: ["senior", "sr.", "lead", "5+ years", "7+ years", "8+ years", "10+ years"],
    executive: ["director", "vp", "head of", "chief", "principal", "executive", "c-level"],
  },

  /**
   * Detect the primary domain of a job from its title and description
   */
  detectDomain: (jobTitle, jobDescription) => {
    const text = `${jobTitle} ${jobDescription}`.toLowerCase();
    const domainScores = {};

    for (const [domain, keywords] of Object.entries(extractionService.domainKeywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          // Title matches are weighted 3x more than description matches
          if (jobTitle.toLowerCase().includes(kw)) {
            score += 3;
          } else {
            score += 1;
          }
        }
      }
      if (score > 0) domainScores[domain] = score;
    }

    // Return the top domain(s) sorted by score
    const sorted = Object.entries(domainScores).sort((a, b) => b[1] - a[1]);
    return {
      primary: sorted[0]?.[0] || "general",
      scores: domainScores,
      all: sorted.map(([d]) => d),
    };
  },

  /**
   * Detect the domain of a candidate from their CV data
   */
  detectCandidateDomain: (candidateSkills, experienceTitles) => {
    const text = [...candidateSkills, ...experienceTitles].join(" ").toLowerCase();
    const domainScores = {};

    for (const [domain, keywords] of Object.entries(extractionService.domainKeywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 1;
      }
      if (score > 0) domainScores[domain] = score;
    }

    const sorted = Object.entries(domainScores).sort((a, b) => b[1] - a[1]);
    return {
      primary: sorted[0]?.[0] || "general",
      scores: domainScores,
      all: sorted.map(([d]) => d),
    };
  },

  extractRequirements: (jobDescription) => {
    const lowerDesc = jobDescription.toLowerCase();

    // 1. Extract Skills — match against full dictionary with word boundary checks
    const skills = [];
    const seen = new Set();

    // Short skills that need strict word boundary matching to avoid false positives
    const shortSkills = new Set(["go", "r", "r programming", "dart", "rust", "swift", "excel", "less", "next", "vue", "node", "flask", "spark", "lean", "git"]);

    extractionService.skillsDictionary.forEach((skill) => {
      if (seen.has(skill)) return;

      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let matched = false;

      if (shortSkills.has(skill)) {
        // Strict word boundary match for short/ambiguous terms
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        matched = regex.test(lowerDesc);
      } else {
        matched = lowerDesc.includes(skill);
      }

      if (matched) {
        seen.add(skill);

        // Importance heuristic: skills mentioned in first 30% of text
        // or mentioned multiple times are more important
        const firstThird = lowerDesc.substring(0, Math.floor(lowerDesc.length * 0.3));
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        const count = (lowerDesc.match(regex) || []).length;
        const inEarlyText = firstThird.includes(skill);
        const importance = (count >= 2 || inEarlyText) ? 4 : 3;

        skills.push({ name: skill, importance });
      }
    });

    // 2. Extract Seniority
    let seniority = "unknown";
    for (const [level, keywords] of Object.entries(extractionService.seniorityKeywords)) {
      if (keywords.some((k) => lowerDesc.includes(k))) {
        seniority = level;
        break;
      }
    }

    // 3. Extract Experience (Regex) — multiple patterns
    const experiencePatterns = [
      /(\d+)\+?\s*years?\s*(?:of\s+)?(?:experience|work|professional|clinical|practice|relevant)/i,
      /(\d+)\+?\s*years?\s*(?:in\s+)/i,
      /(?:minimum|at least|min)\s*(?:of\s+)?(\d+)\s*years?/i,
      /(\d+)\+?\s*years?/i,
    ];
    let minYears = 0;
    for (const pattern of experiencePatterns) {
      const match = lowerDesc.match(pattern);
      if (match) {
        minYears = parseInt(match[1], 10);
        break;
      }
    }

    // 4. Extract Education
    let degree = "Unknown";
    const degreePatterns = [
      { pattern: /(?:phd|ph\.d\.|doctorate|doctoral)/i, degree: "PhD" },
      { pattern: /(?:master'?s?|msc|mba|m\.s\.|m\.a\.)\s*(?:degree)?/i, degree: "Master's" },
      { pattern: /(?:bachelor'?s?|bsc|b\.s\.|b\.a\.|b\.eng|b\.tech|hnd)\s*(?:degree)?/i, degree: "Bachelor's" },
      { pattern: /(?:diploma|ond|nce|certificate)/i, degree: "Diploma" },
      { pattern: /(?:ssce|waec|neco|o'?level|secondary)/i, degree: "High School" },
    ];
    for (const { pattern, degree: d } of degreePatterns) {
      if (pattern.test(lowerDesc)) {
        degree = d;
        break;
      }
    }

    // Extract field of study if mentioned
    let field = null;
    const fieldPatterns = [
      /(?:degree|bachelor|master|bsc|msc)\s+(?:in|of)\s+([\w\s]+?)(?:\.|,|;|\n|or\s|and\s|with)/i,
      /(?:nursing|medicine|engineering|computer science|accounting|law|education|pharmacy)/i,
    ];
    const fieldMatch = lowerDesc.match(fieldPatterns[0]);
    if (fieldMatch) {
      field = fieldMatch[1].trim();
    } else {
      const fieldMatch2 = lowerDesc.match(fieldPatterns[1]);
      if (fieldMatch2) {
        field = fieldMatch2[0];
      }
    }

    return {
      skills,
      experience: { minYears, preferredYears: minYears > 0 ? minYears + 2 : 0 },
      education: degree !== "Unknown" ? { degree, field, fields: field ? [field] : [] } : { degree: "Unknown", fields: [] },
      seniority,
      skillCount: skills.length,
    };
  },

  extractProfile: (resumeText) => {
    const lowerText = resumeText.toLowerCase();

    // 1. Extract Skills
    const skills = [];
    const seen = new Set();
    extractionService.skillsDictionary.forEach((skill) => {
      if (lowerText.includes(skill) && !seen.has(skill)) {
        seen.add(skill);
        skills.push(skill);
      }
    });

    // 2. Extract Experience Analysis
    const experience = [{ years: 1, role: "Professional", company: "Unknown" }];

    return {
      skills,
      experience,
      education: [{ degree: "Unknown", field: "Unknown", school: "Unknown" }],
      seniority: "entry",
    };
  },
};

module.exports = extractionService;
