const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');

const parseResume = async (filePath, mimetype) => {
    try {
        let rawText = '';

        if (mimetype === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            rawText = data.text;
        } else if (
            mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mimetype === 'application/msword'
        ) {
            const result = await mammoth.extractRawText({ path: filePath });
            rawText = result.value;
        } else {
            throw new Error('Unsupported file type');
        }

        // Basic cleaning
        // Remove excessive newlines
        rawText = rawText.replace(/\n\s*\n/g, '\n').trim();

        return {
            rawText,
        };
    } catch (error) {
        console.error('Parsing Error:', error.message);
        throw new Error('Failed to parse resume');
    }
};

module.exports = { parseResume };
