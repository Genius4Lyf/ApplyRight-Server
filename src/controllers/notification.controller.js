const Notification = require('../models/Notification');
const User = require('../models/User');

const NotificationController = {
    // Get notifications for current user
    getMyNotifications: async (req, res) => {
        try {
            const notifications = await Notification.find({ userId: req.user._id })
                .sort({ createdAt: -1 })
                .limit(50); // Limit to last 50

            // Count unread
            const unreadCount = await Notification.countDocuments({ userId: req.user._id, isRead: false });

            res.json({
                notifications,
                unreadCount
            });
        } catch (error) {
            console.error('Get notifications error:', error);
            res.status(500).json({ message: 'Server error' });
        }
    },

    // Mark as read
    markAsRead: async (req, res) => {
        try {
            const { id } = req.params;

            if (id === 'all') {
                await Notification.updateMany(
                    { userId: req.user._id, isRead: false },
                    { isRead: true }
                );
            } else {
                await Notification.findOneAndUpdate(
                    { _id: id, userId: req.user._id },
                    { isRead: true }
                );
            }

            res.json({ success: true });
        } catch (error) {
            console.error('Mark read error:', error);
            res.status(500).json({ message: 'Server error' });
        }
    },

    // Internal helper to create notification (not an endpoint directly, or admin only)
    createNotification: async (userId, title, message, type = 'system', link = null) => {
        try {
            await Notification.create({
                userId,
                title,
                message,
                type,
                link
            });
        } catch (error) {
            console.error('Create notification error:', error);
        }
    },

    // Admin endpoint: Broadcast to all users
    broadcast: async (req, res) => {
        try {
            const { title, message, type, link } = req.body;

            // This could be heavy if millions of users, but fine for now
            // Better approach: Create a "Broadcast" model and pull it on client, 
            // but for Individual alerts this works.

            // For now, let's just find all users and create docs (Background job preferred in production)
            const users = await User.find({}, '_id');
            const notifications = users.map(u => ({
                userId: u._id,
                title,
                message,
                type,
                link
            }));

            await Notification.insertMany(notifications);

            res.json({ success: true, count: users.length });
        } catch (error) {
            console.error('Broadcast error:', error);
            res.status(500).json({ message: 'Server error' });
        }
    }
};

module.exports = NotificationController;
