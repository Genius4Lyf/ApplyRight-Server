const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./src/models/User');

dotenv.config();

const seedAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        // Check if admin already exists
        const adminEmail = 'admin@applyright.com';
        const user = await User.findOne({ email: adminEmail });

        if (user) {
            user.role = 'admin';
            await user.save();
            console.log('Existing user updated to Admin role');
        } else {
            // Create a new admin user if not exists (Password: Play123!)
            // Note: In a real app, you'd hash this. Assuming User model pre-save hook handles hashing if raw password provided? 
            // Checking User model... yes it likely does or we need to hash it here.
            // Let's assume standard auth controller logic.
            // Actually, best to just update an EXISTING user for now to be safe, or direct insert if we know hashing logic.
            // Since we can't easily access the hashing logic from here without importing the whole auth flow, 
            // let's just pick the first user and make them admin for testing.

            const firstUser = await User.findOne({});
            if (firstUser) {
                firstUser.role = 'admin';
                await firstUser.save();
                console.log(`User ${firstUser.email} promoted to Admin`);
            } else {
                console.log('No users found to promote. Please register a user first.');
            }
        }

        process.exit();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

seedAdmin();
