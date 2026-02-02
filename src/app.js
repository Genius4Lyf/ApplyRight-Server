const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(compression());

const corsOptions = {
    origin: process.env.FRONTEND_URL || '*', // STARTUP_CHECK: Configure this to your frontend domain in production
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json()); // Body parser

// Routes (Placeholders)
app.get('/', (req, res) => {
    res.send('ApplyRight API is running...');
});

// Import Routes
// Import Routes
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const jobRoutes = require('./routes/job.routes');
const resumeRoutes = require('./routes/resume.routes');
const aiRoutes = require('./routes/ai.routes');
const applicationRoutes = require('./routes/application.routes');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/resumes', resumeRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/analysis', require('./routes/analysis.routes'));
app.use('/api/cv', require('./routes/cv.routes'));
app.use('/api/pdf', require('./routes/pdf.routes'));
app.use('/api/billing', require('./routes/billing.routes'));


module.exports = app;
