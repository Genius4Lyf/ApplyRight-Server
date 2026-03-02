# ApplyRight — Backend API

The backend REST API powering **ApplyRight**, an AI-driven job application assistant that helps users create professional CVs and cover letters tailored to specific job descriptions.

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js |
| **Framework** | Express 5 |
| **Database** | MongoDB (Mongoose ODM) |
| **Authentication** | JWT (jsonwebtoken) + bcryptjs |
| **AI Providers** | Google Gemini (`@google/generative-ai`) · OpenAI |
| **PDF Generation** | Puppeteer (headless Chrome) |
| **File Parsing** | pdf-parse · mammoth (DOCX) |
| **Web Scraping** | Cheerio + Axios |
| **Security** | Helmet · CORS · Compression |
| **Testing** | Jest · Supertest |
| **Deployment** | Render |

## Features

- **Authentication & Authorization** — Register, login, password reset, JWT-based route protection, admin roles.
- **AI-Powered Content Generation** — Generate and refine CV bullet points, cover letters, and professional summaries using Gemini or OpenAI (configurable via `AI_PROVIDER` env var).
- **Resume Parsing** — Upload and parse PDF/DOCX resumes via `pdf-parse` and `mammoth`.
- **ATS Scoring & Analysis** — Score resumes against job descriptions with keyword-match analysis and actionable improvement suggestions.
- **PDF Export** — Server-side PDF rendering with Puppeteer for pixel-perfect CV downloads.
- **Job Scraping** — Scrape job listing details from URLs using Cheerio.
- **Billing & Transactions** — Credit-based usage model with transaction logging.
- **Admin Dashboard API** — User management, system settings, analytics, and feedback review.
- **Feedback System** — Collect and manage user feedback.

## Project Structure

```
src/
├── app.js                  # Express app setup & middleware
├── server.js               # Entry point — DB connection & server start
├── config/
│   └── db.js               # MongoDB connection config
├── controllers/            # Route handlers (13 modules)
├── middleware/              # Auth, admin, & error middleware
├── models/                 # Mongoose schemas (User, CV, Job, Resume, etc.)
├── routes/                 # Express routers (13 modules)
├── services/               # Business logic
│   ├── ai.service.js       # Gemini / OpenAI integration
│   ├── pdf.service.js      # Puppeteer PDF generation
│   ├── scoring.service.js  # ATS resume scoring engine
│   ├── extraction.service.js
│   ├── jobScraper.service.js
│   ├── resumeParser.service.js
│   └── settings.service.js
├── utils/                  # Shared helpers
└── data/                   # Static seed data
```

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **MongoDB** instance (local or Atlas)
- **Google Chrome** installed (for Puppeteer PDF generation)

### Installation

```bash
# Clone the repo & navigate to the backend
cd applyright-backend

# Install dependencies
npm install

# Install Puppeteer's bundled Chrome (or point to a local install)
npx puppeteer browsers install chrome
```

### Environment Variables

Create a `.env` file in the project root:

```env
PORT=5000
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/Apply-Right
JWT_SECRET=your_jwt_secret

# AI — at least one key required
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...

# Which AI provider to use: "gemini" or "openai"
AI_PROVIDER=gemini

ADMIN_SECRET_KEY=your_admin_secret

# Puppeteer — path to Chrome executable (optional, auto-detected on most systems)
PUPPETEER_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

### Running

```bash
# Development (auto-reload via nodemon)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:5000` by default.

### Testing

```bash
npm test
```

## API Routes Overview

| Prefix | Module | Description |
|---|---|---|
| `/api/auth` | auth | Register, login, password reset |
| `/api/users` | user | Profile management |
| `/api/cv` | cv | Draft CV CRUD |
| `/api/resume` | resume | Resume upload & retrieval |
| `/api/ai` | ai | AI content generation |
| `/api/analysis` | analysis | ATS scoring & analysis |
| `/api/applications` | application | Job application tracking |
| `/api/jobs` | job | Job listing management |
| `/api/pdf` | pdf | Server-side PDF generation |
| `/api/billing` | billing | Credits & transactions |
| `/api/feedback` | feedback | User feedback |
| `/api/admin` | admin | Admin dashboard & settings |
| `/api/system` | system | System health & configuration |

## Deployment

The backend is deployed to **Render**. The `render-build.sh` script handles the build step:

```bash
npm install
npx puppeteer browsers install chrome
```

## License

ISC
