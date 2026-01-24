const { scrapeJob } = require('../services/jobScraper.service');
const Job = require('../models/Job');
const extractionService = require('../services/extraction.service');

// @desc    Extract job details from URL
// @route   POST /api/jobs/extract
// @access  Private
// @desc    Extract job details from URL or Description
// @route   POST /api/jobs/extract
// @access  Private
const extractJob = async (req, res) => {
    const { jobUrl, description } = req.body;

    if (!jobUrl && !description) {
        return res.status(400).json({ message: 'Please provide a job URL or description' });
    }

    try {
        let jobData = {};

        if (jobUrl) {
            jobData = await scrapeJob(jobUrl);
        } else {
            // Text-only mode
            jobData = {
                title: 'Job Application', // Could be improved with NLP to extract title
                company: 'Unknown Company',
                description: description,
                jobUrl: '',
                keywords: [],
            };
        }

        // Perform analysis on the description (scraped or provided)
        const analysis = extractionService.extractRequirements(jobData.description || description);

        // Ensure required fields for Mongoose validation are present
        const jobToSave = {
            title: jobData.title || 'Untitled Job',
            company: jobData.company || 'Unknown Company',
            description: jobData.description || description || 'No description available',
            jobUrl: jobData.jobUrl || jobUrl || '',
            keywords: analysis.skills.map(s => s.name) || [], // Populate keywords from analysis
            analysis: analysis, // Save the detailed analysis
        };

        const job = await Job.create(jobToSave);

        res.status(200).json(job);
    } catch (error) {
        console.error(error);
        if (error.message === 'ACCESS_DENIED') {
            return res.status(403).json({ message: 'Access denied to job URL' });
        }
        if (error.message === 'JOB_NOT_FOUND') {
            return res.status(404).json({ message: 'Job not found' });
        }
        res.status(500).json({ message: 'Failed to extract job details', error: error.message });
    }
};

// @desc    Manually create a job
// @route   POST /api/jobs/manual
// @access  Private
const createJobManual = async (req, res) => {
    const { title, company, description, jobUrl } = req.body;

    if (!title || !company || !description) {
        return res.status(400).json({ message: 'Please provide title, company, and description' });
    }

    try {
        const job = await Job.create({
            title,
            company,
            description,
            jobUrl: jobUrl || '',
        });

        res.status(201).json(job);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to create job' });
    }
};

module.exports = {
    extractJob,
    createJobManual,
};
