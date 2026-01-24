const axios = require('axios');

const url = 'https://shorturl.at/HT4KV';

async function testScrape() {
    console.log(`Testing URL: ${url}`);

    // Method 1: HEAD Request
    try {
        console.log('--- Method 1: HEAD Request ---');
        const headResponse = await axios.head(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/'
            },
            maxRedirects: 0,
            validateStatus: null
        });
        console.log('HEAD Status:', headResponse.status);
        console.log('HEAD Location:', headResponse.headers.location);
    } catch (e) { console.log('HEAD failed:', e.message); }

    // Method 2: Unshorten.me
    try {
        console.log('\n--- Method 2: Unshorten.me ---');
        const unshortenUrl = `https://unshorten.me/json/${url}`;
        const apiResponse = await axios.get(unshortenUrl);
        console.log('API Response:', apiResponse.data);
    } catch (e) { console.log('API failed:', e.message); }
}

testScrape();
