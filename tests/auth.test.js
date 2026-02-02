const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Mock Dependencies
jest.mock('../src/models/User');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

// Mock Data
const mockUser = {
    _id: 'mock-user-id',
    email: 'test@example.com',
    password: 'hashedpassword123',
    phone: '1234567890',
    firstName: 'Test',
    lastName: 'User',
    save: jest.fn().mockResolvedValue(true)
};

describe('Auth API (Mocked DB)', () => {

    beforeEach(() => {
        jest.clearAllMocks();

        // Default Mock Implementations
        // bcrypt
        bcrypt.genSalt.mockResolvedValue('salt');
        bcrypt.hash.mockResolvedValue('hashedpassword123');
        bcrypt.compare.mockResolvedValue(true);

        // jwt
        jwt.sign.mockReturnValue('mock-jwt-token');

        // User static methods default return
        User.findOne.mockResolvedValue(null); // Default: user not found
        User.create.mockResolvedValue(mockUser);
    });

    describe('POST /api/auth/register', () => {
        it('should register a new user successfully', async () => {
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    email: 'new@example.com',
                    password: 'password123',
                    phone: '0987654321'
                });

            expect(res.statusCode).toEqual(201);
            expect(res.body).toHaveProperty('token', 'mock-jwt-token');
            expect(User.create).toHaveBeenCalled();
        });

        it('should return 400 if user already exists', async () => {
            // Mock User.findOne to return existing user
            User.findOne.mockResolvedValue(mockUser);

            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    email: 'test@example.com',
                    password: 'password123',
                    phone: '1234567890'
                });

            expect(res.statusCode).toEqual(400);
            expect(res.body.message).toBe('User already exists');
        });

        it('should return 400 if fields are missing', async () => {
            const res = await request(app)
                .post('/api/auth/register')
                .send({ email: 'test@example.com' }); // Missing password/phone

            expect(res.statusCode).toEqual(400);
        });
    });

    describe('POST /api/auth/login', () => {
        it('should login successfully with correct credentials', async () => {
            // Mock User.findOne to return user
            User.findOne.mockResolvedValue(mockUser);
            // Mock bcrypt.compare to return true
            bcrypt.compare.mockResolvedValue(true);

            const res = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'test@example.com',
                    password: 'password123'
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body).toHaveProperty('token', 'mock-jwt-token');
        });

        it('should reject invalid password', async () => {
            // Mock User.findOne to return user
            User.findOne.mockResolvedValue(mockUser);
            // Mock bcrypt.compare to return false
            bcrypt.compare.mockResolvedValue(false);

            const res = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'test@example.com',
                    password: 'wrongpassword'
                });

            expect(res.statusCode).toEqual(401);
            expect(res.body.message).toBe('Invalid credentials');
        });

        it('should reject non-existent user', async () => {
            // Mock User.findOne to return null
            User.findOne.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'nonexistent@example.com',
                    password: 'password123'
                });

            expect(res.statusCode).toEqual(401);
        });
    });
});
