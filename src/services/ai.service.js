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
        "recommendation": "<short_advice_for_candidate>"
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
        const gradYear = userContext.graduationYear ? parseInt(userContext.graduationYear) : currentYear;
        const isStudent = (currentYear - gradYear) <= 2;
        const tone = isStudent ? "eager and potential-focused" : "confident and results-oriented";

        await new Promise(resolve => setTimeout(resolve, 1500)); // Latency sim

        return {
            optimizedCV: `
# Optimized CV (Mock Mode)
[${isStudent ? 'STUDENT' : 'PROFESSIONAL'} APPROACH APPLIED: ${tone}]
- This is a placeholder generated because no API Key was found.
- To see real AI results, add OPENAI_API_KEY or GEMINI_API_KEY to your .env file.
            `,
            coverLetter: `
Dear Hiring Manager,

This is a placeholder Cover Letter generated in Mock Mode.
Please configure an AI provider to generate tailored content.

Sincerely,
[Candidate Name]
            `
        };
    }

    const prompt = `
    You are an expert Resume Writer for ApplyRight.
    Your goal is to rewrite the candidate's resume to be ATS-optimized and highly professional.
    
    JOB DESCRIPTION:
    ${jobDescription.substring(0, 8000)}

    RESUME:
    ${resumeText.substring(0, 8000)}

    INSTRUCTIONS:
    1. Create a "ApplyRight AI Resume" (Markdown format).
    2. USE STANDARD HEADERS: "Professional Summary", "Experience", "Skills", "Education".
    3. SUMMARY: Write a strong 3-4 line professional summary tailored to the JD.
    4. EXPERIENCE: EXPERTLY REWRITE ALL experience entries. Do NOT summarize or truncate. Convert them into results-oriented bullet points (Action + Task + Result). Use keywords from the JD.
    5. SKILLS & EDUCATION: Include all relevant skills and education.
    6. FORMATTING: Use clean Markdown. No images. Use bullet points (-) for lists.
    7. COVER LETTER: Write a compelling, tailored cover letter.

    IMPORTANT: Output STRICT JSON. Escape all newlines within the JSON string values as "\\n". 
    For paragraphs, use DOUBLE NEWLINES ("\\n\\n") to ensure they are separated.
    Example: { "optimizedCV": "# Header\\n\\nParagraph 1.\\n\\nParagraph 2." }

    Output in JSON format only:
    {
        "optimizedCV": "<markdown_string_of_full_resume>",
        "coverLetter": "<markdown_string_of_cover_letter>"
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
            // Fallback for unescaped newlines within strings (common LLM error)
            // This regex attempts to escape newlines that are NOT structural JSON newlines
            // It's risky so we only try it as a last resort
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

module.exports = {
    analyzeProfile,
    generateOptimizedContent,
    generateInterviewQuestions,
    activeProvider
};
