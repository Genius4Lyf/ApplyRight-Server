const scoringService = {
    calculateFitScore: (jobAnalysis, resumeProfile) => {
        let totalScore = 0;
        let weightedRef = 0; // Total possible weighted score

        // Weights
        const weights = {
            skills: 0.5,
            experience: 0.3,
            seniority: 0.2
        };

        // 1. Skills Score
        const jobSkills = jobAnalysis.skills.map(s => s.name);
        const userSkills = resumeProfile.skills;

        let skillsMatchCount = 0;
        const missingSkills = [];

        jobSkills.forEach(skill => {
            if (userSkills.includes(skill)) {
                skillsMatchCount++;
            } else {
                missingSkills.push(skill);
            }
        });

        const skillsScore = jobSkills.length > 0 ? (skillsMatchCount / jobSkills.length) * 100 : 100;
        totalScore += skillsScore * weights.skills;


        // 2. Experience Score
        // Simplified: if resume has exp entries, check if total years >= minYears
        // Since our extractProfile is mocked for experience, we will skip hard validation for now or use the mock.
        // Let's assume the user has 2 years for the mock.
        const userYears = resumeProfile.experience.reduce((acc, curr) => acc + curr.years, 0);
        const reqYears = jobAnalysis.experience.minYears || 0;

        let experienceScore = 100;
        let experienceMatch = true;

        if (reqYears > 0) {
            if (userYears >= reqYears) {
                experienceScore = 100;
            } else {
                experienceScore = (userYears / reqYears) * 100; // Partial score
                experienceMatch = false;
            }
        }
        totalScore += experienceScore * weights.experience;


        // 3. Seniority Score
        // Simple map: if levels match or user is higher, 100%. Else 50%.
        const levels = ['entry', 'mid', 'senior', 'lead', 'executive'];
        const jobLevelIdx = levels.indexOf(jobAnalysis.seniority);
        const userLevelIdx = levels.indexOf(resumeProfile.seniority);

        let seniorityScore = 100;
        let seniorityMatch = true;

        if (jobLevelIdx !== -1 && userLevelIdx !== -1) {
            if (userLevelIdx < jobLevelIdx) {
                seniorityScore = 50;
                seniorityMatch = false;
            }
        } else if (jobAnalysis.seniority === 'unknown') {
            seniorityScore = 100; // Benefit of doubt
        }
        totalScore += seniorityScore * weights.seniority;


        // Final Rounding
        const finalScore = Math.round(totalScore);

        // Feedback Generation
        let recommendation = '';
        if (finalScore >= 80) {
            recommendation = 'Strong Fit! Apply now and highlight your matching skills.';
        } else if (finalScore >= 50) {
            recommendation = 'Good potential. You meet some key requirements. Apply, but emphasize your transferable skills.';
        } else {
            recommendation = 'This is a reach role. Apply if you are looking to learn, but consider bridging the skill gaps first.';
        }

        return {
            fitScore: finalScore,
            fitAnalysis: {
                overallFeedback: `You match ${skillsMatchCount} out of ${jobSkills.length} required skills.`,
                skillsGap: missingSkills,
                experienceMatch,
                seniorityMatch,
                recommendation
            }
        };
    },

    generateActionPlan: (missingSkills) => {
        const actionDictionary = {
            'python': 'Build a script to automate a daily task or data process.',
            'sql': 'Practice complex joins and window functions on LeetCode.',
            'react': 'Build a responsive personal portfolio website.',
            'node.js': 'Create a simple REST API with Express.',
            'aws': 'Deploy a static site using S3 and CloudFront.',
            'docker': 'Containerize a simple "Hello World" application.',
            'communication': 'Practice the STAR method for behavioral interview questions.',
            'project management': 'Familiarize yourself with Jira or Trello workflows.',
            'git': 'Contribute to an open-source project or learn advanced rebase commands.',
            'excel': 'Master VLOOKUP, Pivot Tables, and Macros.',
            'power bi': 'Create a dashboard visualizing a public dataset.',
            'tableau': 'Build an interactive visualization for a business case.',
            'java': 'Build a small desktop application or API service.',
            'c++': 'Solve algorithmic problems emphasizing memory management.',
            'leadership': 'Reflect on a time you mentored a peer or led a initiative.'
        };

        return missingSkills.map(skill => ({
            skill: skill,
            action: actionDictionary[skill.toLowerCase()] || `Complete a crash course or build a small project using ${skill}.`
        }));
    }
};

module.exports = scoringService;
