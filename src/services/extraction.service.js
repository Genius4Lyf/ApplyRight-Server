const extractionService = {
    // Dictionaries for simple keyword matching
    skillsDictionary: [
        'javascript', 'python', 'java', 'c++', 'react', 'node.js', 'sql', 'nosql', 'mongodb',
        'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'git', 'tableau', 'power bi', 'excel',
        'communication', 'leadership', 'agile', 'scrum', 'project management'
    ],
    seniorityKeywords: {
        entry: ['entry level', 'junior', 'associate', 'intern', '0-2 years'],
        mid: ['mid level', 'mid-senior', 'intermediate', '2-5 years', '3+ years'],
        senior: ['senior', 'sr.', 'lead', '5+ years', '7+ years'],
        executive: ['director', 'vp', 'head of', 'chief', 'principal']
    },

    extractRequirements: (jobDescription) => {
        const lowerDesc = jobDescription.toLowerCase();

        // 1. Extract Skills
        const skills = [];
        extractionService.skillsDictionary.forEach(skill => {
            if (lowerDesc.includes(skill)) {
                // simple importance logic: if it appears multiple times or early, it might be more important.
                // For now, default to 3.
                skills.push({ name: skill, importance: 3 });
            }
        });

        // 2. Extract Seniority
        let seniority = 'unknown';
        for (const [level, keywords] of Object.entries(extractionService.seniorityKeywords)) {
            if (keywords.some(k => lowerDesc.includes(k))) {
                seniority = level;
                break; // prioritize first match hierarchy
            }
        }

        // 3. Extract Experience (Regex)
        // Look for patterns like "3+ years", "5 years of experience"
        const experienceRegex = /(\d+)\+?\s*years?/i;
        const expMatch = lowerDesc.match(experienceRegex);
        let minYears = 0;
        if (expMatch) {
            minYears = parseInt(expMatch[1], 10);
        }

        return {
            skills,
            experience: { minYears, preferredYears: minYears + 2 }, // heuristic
            education: { degree: 'Unknown', fields: [] }, // complex to parse reliably without NLP
            seniority
        };
    },

    extractProfile: (resumeText) => {
        const lowerText = resumeText.toLowerCase();

        // 1. Extract Skills
        const skills = [];
        extractionService.skillsDictionary.forEach(skill => {
            if (lowerText.includes(skill)) {
                skills.push(skill);
            }
        });

        // 2. Extract Experience Analysis (Simplified)
        // We really need section parsing here (Work History vs Education). 
        // For now, we will look for total years mentioned or just rely on manual input in future.
        // Heuristic: sum of all "N years" mentions or date ranges.
        // This is a Placeholder for a more complex parser.
        const experience = [{ years: 1, role: 'Developer', company: 'Unknown' }]; // Mock

        return {
            skills,
            experience,
            education: [{ degree: 'Unknown', field: 'Unknown', school: 'Unknown' }],
            seniority: 'entry' // Default
        };
    }
};

module.exports = extractionService;
