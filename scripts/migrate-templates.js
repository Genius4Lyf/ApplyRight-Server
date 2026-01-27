/**
 * Migration Script: Update Template IDs to ATS Clean
 * 
 * This script updates all applications with 'modern-professional' template
 * to use 'ats-clean' as the default template.
 * 
 * Run this once to fix existing applications in the database.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Application = require('../src/models/Application');

const migrateTemplates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB...');

        // Update all applications with 'modern-professional' to 'ats-clean'
        const result = await Application.updateMany(
            { templateId: 'modern-professional' },
            { $set: { templateId: 'ats-clean' } }
        );

        console.log(`✅ Migration completed!`);
        console.log(`   Updated ${result.modifiedCount} application(s)`);
        console.log(`   Matched ${result.matchedCount} application(s)`);

        // Also update any applications with null/undefined templateId
        const nullResult = await Application.updateMany(
            { $or: [{ templateId: null }, { templateId: { $exists: false } }] },
            { $set: { templateId: 'ats-clean' } }
        );

        if (nullResult.modifiedCount > 0) {
            console.log(`   Fixed ${nullResult.modifiedCount} application(s) with missing templateId`);
        }

        await mongoose.connection.close();
        console.log('✅ Database connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
};

migrateTemplates();
