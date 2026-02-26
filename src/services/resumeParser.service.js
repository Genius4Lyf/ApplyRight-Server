const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');

const buildParserError = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
};

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
            throw buildParserError('Unsupported file type', 'UNSUPPORTED_FILE_TYPE');
        }

        // Basic cleaning
        // Remove excessive newlines
        rawText = rawText.replace(/\n\s*\n/g, '\n').trim();

        if (!rawText) {
            throw buildParserError('No extractable text found in resume', 'EMPTY_RESUME_TEXT');
        }

        return {
            rawText,
        };
    } catch (error) {
        console.error('Parsing Error:', error.message);

        if (error.code === 'UNSUPPORTED_FILE_TYPE' || error.code === 'EMPTY_RESUME_TEXT') {
            throw error;
        }

        throw buildParserError('Failed to parse resume', 'RESUME_PARSE_FAILED');
    }
};

module.exports = { parseResume };
