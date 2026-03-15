/**
 * Skill Normalization Service
 *
 * Normalizes skill names using a synonym dictionary and fuzzy matching.
 * Ensures "React.js", "ReactJS", "React" all map to the same canonical skill.
 */

const stringSimilarity = require("string-similarity");
const Fuse = require("fuse.js");

// ─── Synonym Dictionary ───
// Maps variations → canonical name. Grouped by domain.
const SYNONYMS = {
  // JavaScript ecosystem
  javascript: "JavaScript",
  js: "JavaScript",
  ecmascript: "JavaScript",
  es6: "JavaScript",
  "es2015+": "JavaScript",
  typescript: "TypeScript",
  ts: "TypeScript",
  react: "React",
  "react.js": "React",
  reactjs: "React",
  "react js": "React",
  "next.js": "Next.js",
  nextjs: "Next.js",
  next: "Next.js",
  "vue.js": "Vue.js",
  vuejs: "Vue.js",
  vue: "Vue.js",
  angular: "Angular",
  angularjs: "Angular",
  "angular.js": "Angular",
  svelte: "Svelte",
  "svelte.js": "Svelte",
  "node.js": "Node.js",
  nodejs: "Node.js",
  node: "Node.js",
  express: "Express.js",
  "express.js": "Express.js",
  expressjs: "Express.js",
  jquery: "jQuery",
  "d3.js": "D3.js",
  d3: "D3.js",

  // Python ecosystem
  python: "Python",
  python3: "Python",
  py: "Python",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  "fast api": "FastAPI",
  pandas: "Pandas",
  numpy: "NumPy",
  scipy: "SciPy",
  scikit: "scikit-learn",
  "scikit-learn": "scikit-learn",
  sklearn: "scikit-learn",
  tensorflow: "TensorFlow",
  tf: "TensorFlow",
  pytorch: "PyTorch",
  torch: "PyTorch",

  // Java / JVM
  java: "Java",
  kotlin: "Kotlin",
  "spring boot": "Spring Boot",
  springboot: "Spring Boot",
  spring: "Spring Framework",
  "spring framework": "Spring Framework",

  // Other languages
  "c#": "C#",
  csharp: "C#",
  "c sharp": "C#",
  ".net": ".NET",
  dotnet: ".NET",
  "asp.net": "ASP.NET",
  golang: "Go",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  "ruby on rails": "Ruby on Rails",
  rails: "Ruby on Rails",
  ror: "Ruby on Rails",
  php: "PHP",
  laravel: "Laravel",
  swift: "Swift",
  "objective-c": "Objective-C",
  objc: "Objective-C",
  r: "R",
  "r language": "R",
  scala: "Scala",
  perl: "Perl",
  matlab: "MATLAB",
  dart: "Dart",
  flutter: "Flutter",

  // Databases
  sql: "SQL",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  postgres: "PostgreSQL",
  psql: "PostgreSQL",
  mongodb: "MongoDB",
  mongo: "MongoDB",
  redis: "Redis",
  elasticsearch: "Elasticsearch",
  "elastic search": "Elasticsearch",
  sqlite: "SQLite",
  "microsoft sql server": "SQL Server",
  mssql: "SQL Server",
  "sql server": "SQL Server",
  oracle: "Oracle Database",
  "oracle db": "Oracle Database",
  dynamodb: "DynamoDB",
  "dynamo db": "DynamoDB",
  cassandra: "Cassandra",
  neo4j: "Neo4j",
  firestore: "Firestore",
  firebase: "Firebase",
  supabase: "Supabase",

  // Cloud & Infrastructure
  aws: "AWS",
  "amazon web services": "AWS",
  azure: "Azure",
  "microsoft azure": "Azure",
  gcp: "Google Cloud",
  "google cloud": "Google Cloud",
  "google cloud platform": "Google Cloud",
  docker: "Docker",
  kubernetes: "Kubernetes",
  k8s: "Kubernetes",
  terraform: "Terraform",
  ansible: "Ansible",
  jenkins: "Jenkins",
  "ci/cd": "CI/CD",
  cicd: "CI/CD",
  "continuous integration": "CI/CD",
  "continuous deployment": "CI/CD",
  github: "GitHub",
  "github actions": "GitHub Actions",
  gitlab: "GitLab",
  "gitlab ci": "GitLab CI",
  bitbucket: "Bitbucket",
  heroku: "Heroku",
  vercel: "Vercel",
  netlify: "Netlify",
  nginx: "Nginx",
  apache: "Apache",
  linux: "Linux",
  unix: "Linux",

  // DevOps & Tools
  git: "Git",
  "version control": "Git",
  webpack: "Webpack",
  vite: "Vite",
  babel: "Babel",
  eslint: "ESLint",
  prettier: "Prettier",
  jest: "Jest",
  mocha: "Mocha",
  cypress: "Cypress",
  selenium: "Selenium",
  playwright: "Playwright",
  "react testing library": "React Testing Library",
  rtl: "React Testing Library",
  storybook: "Storybook",
  figma: "Figma",
  sketch: "Sketch",
  "adobe xd": "Adobe XD",

  // Data & ML
  "machine learning": "Machine Learning",
  ml: "Machine Learning",
  "deep learning": "Deep Learning",
  dl: "Deep Learning",
  nlp: "Natural Language Processing",
  "natural language processing": "Natural Language Processing",
  "computer vision": "Computer Vision",
  cv: "Computer Vision",
  "data science": "Data Science",
  "data analysis": "Data Analysis",
  "data analytics": "Data Analysis",
  "data engineering": "Data Engineering",
  etl: "ETL",
  "data pipeline": "ETL",
  "apache spark": "Apache Spark",
  spark: "Apache Spark",
  hadoop: "Hadoop",
  airflow: "Apache Airflow",
  "apache airflow": "Apache Airflow",
  kafka: "Apache Kafka",
  "apache kafka": "Apache Kafka",
  "power bi": "Power BI",
  powerbi: "Power BI",
  tableau: "Tableau",
  looker: "Looker",

  // APIs & Protocols
  rest: "REST APIs",
  "rest api": "REST APIs",
  "rest apis": "REST APIs",
  restful: "REST APIs",
  "restful api": "REST APIs",
  graphql: "GraphQL",
  "graph ql": "GraphQL",
  grpc: "gRPC",
  websocket: "WebSockets",
  websockets: "WebSockets",
  soap: "SOAP",

  // Frontend skills
  html: "HTML",
  html5: "HTML",
  css: "CSS",
  css3: "CSS",
  sass: "Sass",
  scss: "Sass",
  less: "Less",
  tailwind: "Tailwind CSS",
  "tailwind css": "Tailwind CSS",
  tailwindcss: "Tailwind CSS",
  bootstrap: "Bootstrap",
  "material ui": "Material UI",
  mui: "Material UI",
  "chakra ui": "Chakra UI",
  "styled components": "Styled Components",
  "styled-components": "Styled Components",
  "responsive design": "Responsive Design",
  "responsive web design": "Responsive Design",
  accessibility: "Accessibility",
  a11y: "Accessibility",
  wcag: "Accessibility",
  seo: "SEO",

  // Mobile
  "react native": "React Native",
  "react-native": "React Native",
  ios: "iOS Development",
  "ios development": "iOS Development",
  android: "Android Development",
  "android development": "Android Development",
  "mobile development": "Mobile Development",
  "mobile dev": "Mobile Development",
  "cross-platform": "Cross-Platform Development",

  // Methodologies
  agile: "Agile",
  scrum: "Scrum",
  kanban: "Kanban",
  "test driven development": "TDD",
  tdd: "TDD",
  "behavior driven development": "BDD",
  bdd: "BDD",
  "pair programming": "Pair Programming",
  "code review": "Code Review",
  "design patterns": "Design Patterns",
  oop: "Object-Oriented Programming",
  "object-oriented programming": "Object-Oriented Programming",
  "object oriented programming": "Object-Oriented Programming",
  fp: "Functional Programming",
  "functional programming": "Functional Programming",
  microservices: "Microservices",
  "micro services": "Microservices",
  "event driven": "Event-Driven Architecture",
  "event-driven architecture": "Event-Driven Architecture",
  serverless: "Serverless",

  // Security
  oauth: "OAuth",
  oauth2: "OAuth",
  "oauth 2.0": "OAuth",
  jwt: "JWT",
  "json web token": "JWT",
  "json web tokens": "JWT",
  authentication: "Authentication",
  auth: "Authentication",
  authorization: "Authorization",
  cybersecurity: "Cybersecurity",
  "cyber security": "Cybersecurity",
  "information security": "Cybersecurity",
  penetration: "Penetration Testing",
  "penetration testing": "Penetration Testing",
  "pen testing": "Penetration Testing",

  // Soft skills / business
  "project management": "Project Management",
  "product management": "Product Management",
  leadership: "Leadership",
  communication: "Communication",
  "team management": "Team Management",
  "cross-functional": "Cross-Functional Collaboration",
  stakeholder: "Stakeholder Management",
  "stakeholder management": "Stakeholder Management",
  presentation: "Presentation Skills",
  "public speaking": "Presentation Skills",
  "problem solving": "Problem Solving",
  "problem-solving": "Problem Solving",
  "critical thinking": "Critical Thinking",
  "time management": "Time Management",
  mentoring: "Mentoring",
  coaching: "Mentoring",
};

// Build canonical skills list for fuzzy search
const CANONICAL_SKILLS = [...new Set(Object.values(SYNONYMS))];

// Fuse.js instance for fuzzy search on canonical names
const fuse = new Fuse(
  CANONICAL_SKILLS.map((s) => ({ name: s })),
  {
    keys: ["name"],
    threshold: 0.3,
    includeScore: true,
  }
);

/**
 * Normalize a single skill string to its canonical form.
 *
 * Strategy (in order):
 * 1. Exact match in synonym dictionary
 * 2. Fuzzy match against canonical skills (string-similarity ≥ 0.8)
 * 3. Fuse.js search (threshold 0.3)
 * 4. Return original with title-casing
 *
 * @param {string} raw - Raw skill string from AI extraction
 * @returns {{ canonical: string, confidence: number, method: string }}
 */
const normalizeSkill = (raw) => {
  if (!raw || typeof raw !== "string") {
    return { canonical: "", confidence: 0, method: "invalid" };
  }

  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();

  // 1. Exact synonym match
  if (SYNONYMS[lower]) {
    return {
      canonical: SYNONYMS[lower],
      confidence: 1.0,
      method: "synonym",
    };
  }

  // 2. String similarity against canonical skills
  const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(
    lower,
    CANONICAL_SKILLS.map((s) => s.toLowerCase())
  );

  if (bestMatch.rating >= 0.8) {
    return {
      canonical: CANONICAL_SKILLS[bestMatchIndex],
      confidence: bestMatch.rating,
      method: "similarity",
    };
  }

  // 3. Fuse.js fuzzy search
  const fuseResults = fuse.search(cleaned);
  if (fuseResults.length > 0 && fuseResults[0].score < 0.3) {
    return {
      canonical: fuseResults[0].item.name,
      confidence: 1 - fuseResults[0].score,
      method: "fuzzy",
    };
  }

  // 4. Fallback — title case the original
  const titleCased = cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return {
    canonical: titleCased,
    confidence: 0.5,
    method: "passthrough",
  };
};

/**
 * Normalize an array of skill strings and deduplicate.
 *
 * @param {string[]} skills - Raw skill names
 * @returns {{ canonical: string, confidence: number, method: string }[]}
 */
const normalizeSkills = (skills) => {
  if (!Array.isArray(skills)) return [];

  const seen = new Set();
  const results = [];

  for (const raw of skills) {
    const result = normalizeSkill(raw);
    if (!result.canonical) continue;

    const key = result.canonical.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    results.push(result);
  }

  return results;
};

/**
 * Compare two skill sets and compute match/gap analysis.
 *
 * @param {string[]} candidateSkills - Normalized candidate skills
 * @param {{ name: string, importance: string }[]} requiredSkills - Required skills from JD
 * @returns {{ matched: object[], missing: object[], matchRate: number, mustHaveMatchRate: number }}
 */
const compareSkills = (candidateSkills, requiredSkills) => {
  const candidateNormalized = normalizeSkills(candidateSkills);
  const candidateSet = new Set(
    candidateNormalized.map((s) => s.canonical.toLowerCase())
  );

  const matched = [];
  const missing = [];

  for (const req of requiredSkills) {
    const reqNorm = normalizeSkill(req.name);
    const reqKey = reqNorm.canonical.toLowerCase();

    // Direct match
    if (candidateSet.has(reqKey)) {
      matched.push({
        name: reqNorm.canonical,
        importance: req.importance || "nice_to_have",
        matchConfidence: reqNorm.confidence,
      });
      continue;
    }

    // Fuzzy match against each candidate skill
    let bestFuzzy = { rating: 0, index: -1 };
    const candidateArr = candidateNormalized.map((s) =>
      s.canonical.toLowerCase()
    );

    if (candidateArr.length > 0) {
      const result = stringSimilarity.findBestMatch(reqKey, candidateArr);
      bestFuzzy = result.bestMatch;
    }

    if (bestFuzzy.rating >= 0.7) {
      matched.push({
        name: reqNorm.canonical,
        importance: req.importance || "nice_to_have",
        matchConfidence: bestFuzzy.rating,
        matchedWith: candidateNormalized.find(
          (s) =>
            s.canonical.toLowerCase() ===
            candidateArr[
              stringSimilarity.findBestMatch(reqKey, candidateArr)
                .bestMatchIndex
            ]
        )?.canonical,
      });
    } else {
      missing.push({
        name: reqNorm.canonical,
        importance: req.importance || "nice_to_have",
      });
    }
  }

  const mustHaveTotal = requiredSkills.filter(
    (s) => s.importance === "must_have"
  ).length;
  const mustHaveMatched = matched.filter(
    (s) => s.importance === "must_have"
  ).length;

  return {
    matched,
    missing,
    matchRate:
      requiredSkills.length > 0
        ? Math.round((matched.length / requiredSkills.length) * 100)
        : 100,
    mustHaveMatchRate:
      mustHaveTotal > 0
        ? Math.round((mustHaveMatched / mustHaveTotal) * 100)
        : 100,
  };
};

module.exports = {
  normalizeSkill,
  normalizeSkills,
  compareSkills,
  CANONICAL_SKILLS,
  SYNONYMS,
};
