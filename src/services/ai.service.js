const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let openai;
let geminiModel;
let activeProvider = 'mock'; // 'openai', 'gemini', or 'mock'

// Initialize Clients
// Initialize Clients
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    activeProvider = 'openai';
    console.log('✅ AI Service: OpenAI Enabled');
} else if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Use a fast model
    activeProvider = 'gemini';
    console.log('✅ AI Service: Gemini Enabled');
} else {
    // Requested Enhancement: Explicitly log error to terminal when keys are missing
    console.log('\n❌ [ERROR] AI Service Initialization Failed');
    console.log('   Reason: No API Keys found (OPENAI_API_KEY or GEMINI_API_KEY)');
    console.log('   Action: Falling back to Mock Mode. Real analysis will not work.\n');
}

const analyzeProfile = async (resumeText, jobDescription) => {
    if (activeProvider === 'mock') {
        return mockAnalysis();
    }

    const prompt = `
    You are an expert HR Recruiter and Technical Hiring Manager.
    Analyze the following Candidate Resume against the Job Description.

    JOB DESCRIPTION:
    ${jobDescription.substring(0, 2000)}

    RESUME:
    ${resumeText.substring(0, 2000)}

    EXTRACT METADATA:
    - Look for the specific role being hired (e.g., "Fuel Receipt Officer"). Ignore generic headers.
    - Look for the hiring company (e.g., "Dangote Industries"). Ignore recuitment agencies (e.g., "Work Link", "Jobberman") if possible.

    Output a JSON object ONLY. Do not output markdown code blocks. Structure:
    {
        "detectedJobTitle": "<extracted_job_title_from_text>",
        "detectedCompany": "<extracted_company_name_from_text>",
        "skills": ["matched_skill_1", "matched_skill_2"],
        "missingSkills": ["important_missing_skill"],
        "experienceYears": <integer_estimate_of_total_relevant_experience>,
        "seniority": "<one_of: entry, mid, senior, executive>",
        "reasoning": "<short_sentence_explaining_seniority_and_fit>",
        "fitScore": <integer_0_to_100_based_on_overall_match>,
        "recommendation": "<short_advice_for_candidate>",
        "actionPlan": [
            { "skill": "missing_skill_1", "action": "Specific, actionable advice (e.g., Build a project using X...)" }
        ]
    }
    `;

    try {
        let resultText = '';

        if (activeProvider === 'openai') {
            const response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo", // Cost effective
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2, // Low creativity for analysis
            });
            resultText = response.choices[0].message.content;

        } else if (activeProvider === 'gemini') {
            const result = await geminiModel.generateContent(prompt);
            resultText = result.response.text();
        }

        // Clean up markdown code blocks if AI adds them
        const jsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
        return {
            ...JSON.parse(jsonStr),
            mode: 'AI',
            provider: activeProvider
        };

    } catch (error) {
        console.error('AI Analysis Failed, falling back to mock:', error);
        return mockAnalysis();
    }
};

const generateOptimizedContent = async (resumeText, jobDescription, userContext = {}) => {
    // If mock mode, return the old mock response
    if (activeProvider === 'mock') {
        const currentYear = new Date().getFullYear();
        await new Promise(resolve => setTimeout(resolve, 1500)); // Latency sim

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

## Projects
### E-Commerce Platform
- Built a fully functional e-commerce platform supporting 10k+ daily users.
- implemented JWT authentication and role-based access control.
- Designed RESTful APIs for product management and order processing.

## Education
### Bachelor of Science in Computer Science
University of Technology | 2017 - 2021
- GPA: 3.8/4.0
- Relevant Coursework: Data Structures, Algorithms, Distributed Systems
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
            `.trim()
        };
    }

    const prompt = `
    You are an ATS-optimization engine for ApplyRight.
    Your job is to convert unstructured user career data into a clean, ATS-compliant CV using a strict pipeline.

    INPUT DATA:
    JOB DESCRIPTION:
    ${jobDescription.substring(0, 8000)}

    USER RESUME:
    ${resumeText.substring(0, 8000)}

    TASK:
    Apply the following process exactly:

    Step 1 — Extract
    Identify: name, contact info, roles, employers, dates, skills, education, projects.

    Step 2 — Normalize
    - Generate a Professional Summary by analyzing the candidate's Work History and Skills. Highlight key achievements and relevance to the Job Description.
    - Convert job descriptions into achievement-oriented bullet points (Action + Task + Result).
    - Standardize job titles and dates.

    Step 3 — ATS Optimization
    - Use industry-standard keywords inferred from the user’s background and Job Description.
    - Avoid buzzwords and personal pronouns (I, me, my).
    - Keep language factual and concise.

    Step 4 — Section Mapping
    Map all content strictly into these sections (use exactly these headers):
    - ## Professional Summary
    - ## Work History
    - ## Skills
    - ## Projects
    - ## Education

    Step 5 — Output Format
    1. START WITH: "# [Full Name in CAPS]" as the very first line.
    2. Follow with "## Professional Summary" as a paragraph.
    3. For "## Work History", use sub-headers "### [Job Title]" followed by "[Company Name] | [Dates]" on the next line, then bullet points.
    4. For "## Skills", use bullet points. GROUP SKILLS DYNAMICALLY based on the candidate's specific domain.
       - Example for Dev: "- **Frontend:** React, CSS... \\n - **Backend:** Node, SQL..."
       - Example for Nurse: "- **Clinical Care:** Triage, Phlebotomy... \\n - **Compliance:** HIPAA, OSHA..."
       - Example for Sales: "- **CRM Tools:** Salesforce, HubSpot... \\n - **Strategies:** Lead Gen, Closing..."
       - DO NOT use generic "Technical/Soft Skills" headers unless absolutely necessary. Infer the best professional categories.
    5. For "## Projects", use sub-headers "### [Project Name]" followed by bullet points.
    6. For "## Education", use sub-headers "### [Degree]" followed by "[Institution] | [Dates]" and bullet points (e.g., GPA or Honors).

    IMPORTANT: Output STRICT JSON. Escape all newlines within the JSON string values as "\\n". 
    For paragraphs, use DOUBLE NEWLINES ("\\n\\n").
    
    Output in JSON format only:
    {
        "optimizedCV": "<markdown_string_of_full_resume>",
        "coverLetter": "<markdown_string_of_tailored_cover_letter>"
    }
    `;

    try {
        let resultText = '';
        if (activeProvider === 'openai') {
            const response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }]
            });
            resultText = response.choices[0].message.content;
        } else if (activeProvider === 'gemini') {
            const result = await geminiModel.generateContent(prompt);
            resultText = result.response.text();
        }

        // Locate the JSON block (find first '{' and last '}')
        let jsonStr = resultText;
        const startIndex = resultText.indexOf('{');
        const endIndex = resultText.lastIndexOf('}');

        if (startIndex !== -1 && endIndex !== -1) {
            jsonStr = resultText.substring(startIndex, endIndex + 1);
        }

        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            console.error("JSON Parse Failed. Raw AI Response (First 500 chars):", resultText.substring(0, 500));
            try {
                const fixedStr = jsonStr.replace(/(?<!["}])\n/g, '\\n');
                return JSON.parse(fixedStr);
            } catch (retryError) {
                return {
                    optimizedCV: "# Error Parsing AI Response\n\nThe AI generated content but it was not in a valid format. Please try regenerating.",
                    coverLetter: "Error parsing AI response."
                };
            }
        }

    } catch (error) {
        console.error("AI Generation Failed", error);
        return { optimizedCV: "Error generating content.", coverLetter: "Error generating content." };
    }
};

const mockAnalysis = () => {
    return {
        skills: ['javascript', 'react', 'mock-skill'],
        missingSkills: ['real-ai-key'],
        experienceYears: 1,
        seniority: 'entry',
        reasoning: 'Analysis performed in Mock/Offline Mode.',
        fitScore: 50,
        recommendation: 'Add an API Key to enable AI analysis.',
        actionPlan: [
            { skill: 'real-ai-key', action: 'Sign up for OpenAI or Google Gemini and add the key to .env' }
        ],
        mode: 'Standard',
        provider: 'local'
    };
};

const generateInterviewQuestions = async (jobDescription, userSkills) => {
    if (activeProvider === 'mock') {
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
        let resultText = '';
        if (activeProvider === 'openai') {
            const response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }]
            });
            resultText = response.choices[0].message.content;
        } else if (activeProvider === 'gemini') {
            const result = await geminiModel.generateContent(prompt);
            resultText = result.response.text();
        }

        // Clean up markdown code blocks if AI adds them
        let jsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();

        // Helper to extract JSON if it's wrapped in other text
        const startIndex = jsonStr.indexOf('{');
        const endIndex = jsonStr.lastIndexOf('}');
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
        { type: 'behavioral', question: 'Tell me about a time you handled a difficult stakeholder.' },
        { type: 'behavioral', question: 'Describe a situation where you had to learn a new tool quickly.' }
    ];

    const techKeywords = ['react', 'node', 'sql', 'python', 'aws', 'docker', 'java', 'communication', 'sales', 'marketing'];
    const lowerJD = jobDescription.toLowerCase();

    techKeywords.forEach(tech => {
        if (lowerJD.includes(tech)) {
            questions.push({
                type: 'technical',
                question: `Explain how you have used ${tech} in a recent project. What challenges did you face?`
            });
        }
    });

    const questionsToAsk = [
        "What does success look like in this role for the first 90 days?",
        "Can you describe the team culture and how you collaborate?",
        "What are the biggest challenges the team is currently facing?"
    ];

    if (lowerJD.includes('agile') || lowerJD.includes('scrum')) {
        questionsToAsk.push("How does your team practice Agile/Scrum day-to-day?");
    }
    if (lowerJD.includes('leadership') || lowerJD.includes('manage')) {
        questionsToAsk.push("How does your team practice Agile/Scrum day-to-day?");
    }
    if (lowerJD.includes('remote') || lowerJD.includes('hybrid')) {
        questionsToAsk.push("How does the team maintain communication in a remote/hybrid setting?");
    }

    return {
        questionsToAnswer: questions.slice(0, 3),
        questionsToAsk: questionsToAsk.slice(0, 3)
    };
};

const extractResumeProfile = async (resumeText) => {
    if (activeProvider === 'mock') {
        return mockResumeExtraction();
    }

    const prompt = `
    You are an expert Resume Parser.
    Extract structured data from the following resume text.

    RESUME TEXT:
    ${resumeText.substring(0, 4000)}

    INSTRUCTIONS:
    1. Extract SKILLS as an array of strings.
    2. Extract EXPERIENCE as an array of objects: { "role": "...", "company": "...", "years": <number estimated duration> }.
    3. Extract EDUCATION as an array of objects: { "degree": "...", "field": "...", "school": "..." }.
    4. Estimate SENIORITY level: 'entry', 'mid', 'senior', or 'executive'.

    Output STRICT JSON format only:
    {
        "skills": ["..."],
        "experience": [{...}],
        "education": [{...}],
        "seniority": "..."
    }
    `;

    try {
        let resultText = '';
        if (activeProvider === 'openai') {
            const response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
            });
            resultText = response.choices[0].message.content;
        } else if (activeProvider === 'gemini') {
            const result = await geminiModel.generateContent(prompt);
            resultText = result.response.text();
        }

        let jsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
        const startIndex = jsonStr.indexOf('{');
        const endIndex = jsonStr.lastIndexOf('}');
        if (startIndex !== -1 && endIndex !== -1) {
            jsonStr = jsonStr.substring(startIndex, endIndex + 1);
        }

        return JSON.parse(jsonStr);

    } catch (error) {
        console.error("AI Resume Extraction Failed:", error);
        return mockResumeExtraction();
    }
};

const mockResumeExtraction = () => {
    return {
        skills: ['Mock Skill 1', 'Mock Skill 2'],
        experience: [{ role: 'Mock Role', company: 'Mock Co', years: 1 }],
        education: [{ degree: 'BS', field: 'CS', school: 'Mock Univ' }],
        seniority: 'entry'
    };
};

module.exports = {
    analyzeProfile,
    generateOptimizedContent,
    generateInterviewQuestions,
    extractResumeProfile,
    activeProvider
};
