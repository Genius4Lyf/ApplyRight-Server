const axios = require('axios');
const cheerio = require('cheerio');

const scrapeJob = async (url) => {
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        const $ = cheerio.load(data);

        // Basic Extraction Strategy
        let title = $('h1').first().text().trim() || $('title').text().trim();

        // Extended Company Extraction Strategy
        let company = '';

        // 1. Try common meta tags
        company = $('meta[property="og:site_name"]').attr('content') ||
            $('meta[name="twitter:site"]').attr('content') ||
            $('meta[name="author"]').attr('content');

        // 2. Try JSON-LD (Schema.org)
        if (!company) {
            $('script[type="application/ld+json"]').each((i, el) => {
                try {
                    const json = JSON.parse($(el).html());
                    const hiringOrganization = json.hiringOrganization || json.author || json.publisher;
                    if (hiringOrganization && hiringOrganization.name) {
                        company = hiringOrganization.name;
                        return false; // break
                    }
                } catch (e) {
                    // skip malformed JSON
                }
            });
        }

        // 3. Try common class names or IDs for company
        if (!company) {
            const companySelectors = [
                '.company-name',
                '.job-company',
                '[data-company]',
                '.hiring-organization',
                '.top-card-layout__first-subline-link' // LinkedIn specific
            ];
            for (const selector of companySelectors) {
                if ($(selector).length > 0) {
                    company = $(selector).first().text().trim();
                    break;
                }
            }
        }

        // 4. Fallback: Extract from Title if it contains "at [Company]" or " - [Company]"
        if (!company && title.includes(' at ')) {
            company = title.split(' at ').pop().trim();
        } else if (!company && title.includes(' - ')) {
            company = title.split(' - ').pop().trim();
        }

        // Final Fallback: Set to "Unknown Company" to satisfy DB constraint
        if (!company) {
            company = 'Unknown Company';
        }

        let description = '';

        // Try to find description in common containers
        const descriptionSelectors = [
            '#job-details',
            '.job-description',
            '[data-testid="job-description"]',
            'article',
            'main',
        ];

        for (const selector of descriptionSelectors) {
            if ($(selector).length > 0) {
                description = $(selector).text().trim();
                break;
            }
        }

        if (!description) {
            description = $('body').text().trim().substring(0, 2000); // Fallback to partial body text
        }

        // Clean up text
        description = description.replace(/\s+/g, ' ').trim();

        return {
            title,
            company,
            description,
            jobUrl: url,
        };
    } catch (error) {
        if (error.response) {
            if (error.response.status === 403 || error.response.status === 401) {
                console.error('Scraping Access Denied:', error.response.status);
                throw new Error('ACCESS_DENIED');
            }
            if (error.response.status === 404) {
                throw new Error('JOB_NOT_FOUND');
            }
        }
        console.error('Scraping Error:', error.message);
        throw new Error('Failed to scrape job details');
    }
};

module.exports = { scrapeJob };
