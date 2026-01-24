const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Configuration
const API_URL = 'http://localhost:5000/api';
const EMAIL = `test.user.${Date.now()}@example.com`;
const PASSWORD = 'password123';

async function runTest() {
    console.log('Starting End-to-End Test Suite...');

    let token;
    let userId;
    let resumeId;
    let jobId;

    // 1. Register User
    try {
        console.log(`\n[Step 1] Registering user: ${EMAIL}...`);
        const registerRes = await axios.post(`${API_URL}/auth/register`, {
            email: EMAIL,
            password: PASSWORD
        });

        if (registerRes.status === 201) {
            console.log('✅ Registration Successful');
        } else {
            throw new Error(`Registration failed with status: ${registerRes.status}`);
        }
    } catch (error) {
        console.error('❌ Registration Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }

    // 2. Login & Validate Shape
    try {
        console.log('\n[Step 2] Logging in and validating response shape...');
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: EMAIL,
            password: PASSWORD
        });

        const data = loginRes.data;
        const keys = Object.keys(data);

        // Strict Shape Validation: { _id, email, token }
        const hasId = '_id' in data;
        const hasEmail = 'email' in data;
        const hasToken = 'token' in data;
        const correctLength = keys.length === 3;

        if (hasId && hasEmail && hasToken && correctLength) {
            console.log('✅ Login Response Shape Validated: { _id, email, token }');
            console.log(`   Token: ${data.token.substring(0, 10)}...`);
            token = data.token;
            userId = data._id;
        } else {
            console.error('❌ Invalid Login Response Shape:', keys);
            throw new Error('Login response shape mismatch');
        }

    } catch (error) {
        console.error('❌ Login Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }

    // Auth Header for subsequent requests
    const authConfig = {
        headers: {
            Authorization: `Bearer ${token}`
        }
    };

    // 3. Upload Resume
    try {
        console.log('\n[Step 3] Uploading Resume...');
        const resumePath = path.join(__dirname, 'assets', 'test-resume.txt');

        if (!fs.existsSync(resumePath)) {
            throw new Error(`Resume file not found at: ${resumePath}`);
        }

        const form = new FormData();
        form.append('resume', fs.createReadStream(resumePath));

        const uploadRes = await axios.post(`${API_URL}/resumes/upload`, form, {
            headers: {
                ...authConfig.headers,
                ...form.getHeaders()
            }
        });

        if (uploadRes.status === 201) {
            resumeId = uploadRes.data._id;
            console.log(`✅ Resume Uploaded. ID: ${resumeId}`);
        } else {
            throw new Error(`Resume upload failed: ${uploadRes.status}`);
        }

    } catch (error) {
        console.error('❌ Resume Upload Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }

    // 4. Create Job
    try {
        console.log('\n[Step 4] Creating Manual Job...');
        const jobData = {
            title: 'Senior Software Engineer',
            company: 'Tech Corp',
            description: 'We are looking for a Senior Software Engineer with Node.js and React experience.',
            jobUrl: 'https://example.com/job/123'
        };

        const jobRes = await axios.post(`${API_URL}/jobs/manual`, jobData, authConfig);

        if (jobRes.status === 201) {
            jobId = jobRes.data._id;
            console.log(`✅ Job Created. ID: ${jobId}`);
        } else {
            throw new Error(`Job creation failed: ${jobRes.status}`);
        }

    } catch (error) {
        console.error('❌ Job Creation Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }

    // 5. Generate Application
    try {
        console.log('\n[Step 5] Generating Application (AI)...');
        console.log(`   Using Resume ID: ${resumeId}`);
        console.log(`   Using Job ID: ${jobId}`);

        const appRes = await axios.post(`${API_URL}/ai/generate`, {
            resumeId,
            jobId
        }, authConfig);

        if (appRes.status === 201) {
            const { optimizedCV, coverLetter } = appRes.data;
            if (optimizedCV && coverLetter) {
                console.log('✅ Application Generated Successfully');
                console.log('   Preview (Optimized CV):', optimizedCV.substring(0, 50) + '...');
            } else {
                throw new Error('Application generated but missing content fields');
            }
        } else {
            throw new Error(`Application generation failed: ${appRes.status}`);
        }

    } catch (error) {
        console.error('❌ Application Generation Failed:', error.response ? error.response.data : error.message);
        // Note: This might fail if the AI service mocking/real service isn't robust, but we test the endpoint mechanics.
        process.exit(1);
    }

    console.log('\n🎉 ALL TESTS PASSED!');
}

runTest();
