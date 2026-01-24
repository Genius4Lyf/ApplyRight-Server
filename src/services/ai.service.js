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

    Output a JSON object ONLY. Do not output markdown code blocks. Structure:
    {
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
    You are an expert Resume Writer.
    Rewrite the candidate's resume summary and experience bullets to better match the job description.
    Also write a compelling cover letter.
    
    JOB DESCRIPTION:
    ${jobDescription.substring(0, 1000)}

    RESUME:
    ${resumeText.substring(0, 1000)}

    Output in JSON format only:
    {
        "optimizedCV": "<markdown_string_of_improved_sections>",
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

        const jsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);

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
    // In a real app, this would use an LLM. 
    // Here we use heuristics based on keywords in the JD.
    const questions = [
        { type: 'behavioral', question: 'Tell me about a time you handled a difficult stakeholder.' },
        { type: 'behavioral', question: 'Describe a situation where you had to learn a new tool quickly.' }
    ];

    const techKeywords = ['react', 'node', 'sql', 'python', 'aws', 'docker', 'java', 'communication'];
    const lowerJD = jobDescription.toLowerCase();

    techKeywords.forEach(tech => {
        if (lowerJD.includes(tech)) {
            questions.push({
                type: 'technical',
                question: `Explain how you have used ${tech} in a recent project. What challenges did you face?`
            });
        }
    });

    return questions.slice(0, 5); // Return top 5
};

module.exports = {
    analyzeProfile,
    generateOptimizedContent,
    generateInterviewQuestions,
    activeProvider
};
