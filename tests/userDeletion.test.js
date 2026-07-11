const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Resume = require("../src/models/Resume");
const Application = require("../src/models/Application");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const AICallLog = require("../src/models/AICallLog");
const DownloadLog = require("../src/models/DownloadLog");
const Feedback = require("../src/models/Feedback");
const Notification = require("../src/models/Notification");

// Mock protect middleware
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/middleware/auth.middleware", () => ({
  protect: (req, res, next) => {
    req.user = { id: "mock-user-id" };
    next();
  },
  admin: (req, res, next) => next(),
  agent: (req, res, next) => next(),
  requireTier: () => (req, res, next) => next(),
}));

// Mock SettingsService to bypass DB checks in maintenance middleware
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    features: { maintenanceMode: false },
    credits: { signupBonus: 10, referralBonus: 5 },
  }),
  getCreditCosts: jest
    .fn()
    .mockResolvedValue(require("../src/config/creditCosts").getDefaults()),
}));

// Mock Models with explicit factories to avoid Mongoose compilation errors in Jest
jest.mock("../src/models/User", () => ({
  findByIdAndDelete: jest.fn(),
}));
jest.mock("../src/models/Resume", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/Application", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/DraftCV", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/Transaction", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/AICallLog", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/DownloadLog", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/Feedback", () => ({
  deleteMany: jest.fn(),
}));
jest.mock("../src/models/Notification", () => ({
  deleteMany: jest.fn(),
}));

describe("User Deletion API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should successfully cascade delete all user data and then delete the user account", async () => {
    // Setup Mock Returns
    Resume.deleteMany.mockResolvedValue({ deletedCount: 2 });
    Application.deleteMany.mockResolvedValue({ deletedCount: 3 });
    DraftCV.deleteMany.mockResolvedValue({ deletedCount: 1 });
    Transaction.deleteMany.mockResolvedValue({ deletedCount: 5 });
    AICallLog.deleteMany.mockResolvedValue({ deletedCount: 10 });
    DownloadLog.deleteMany.mockResolvedValue({ deletedCount: 2 });
    Feedback.deleteMany.mockResolvedValue({ deletedCount: 1 });
    Notification.deleteMany.mockResolvedValue({ deletedCount: 4 });
    User.findByIdAndDelete.mockResolvedValue({ _id: "mock-user-id" });

    const res = await request(app)
      .delete("/api/users/profile")
      .set("Authorization", "Bearer mock-jwt-token");

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toContain("deleted successfully");

    // Verify cascade calls
    expect(Resume.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(Application.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(DraftCV.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(Transaction.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(AICallLog.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(DownloadLog.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(Feedback.deleteMany).toHaveBeenCalledWith({ user: "mock-user-id" });
    expect(Notification.deleteMany).toHaveBeenCalledWith({ userId: "mock-user-id" });
    expect(User.findByIdAndDelete).toHaveBeenCalledWith("mock-user-id");
  });

  it("should return 404 if the user is not found during deletion", async () => {
    Resume.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Application.deleteMany.mockResolvedValue({ deletedCount: 0 });
    DraftCV.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Transaction.deleteMany.mockResolvedValue({ deletedCount: 0 });
    AICallLog.deleteMany.mockResolvedValue({ deletedCount: 0 });
    DownloadLog.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Feedback.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Notification.deleteMany.mockResolvedValue({ deletedCount: 0 });
    User.findByIdAndDelete.mockResolvedValue(null);

    const res = await request(app)
      .delete("/api/users/profile")
      .set("Authorization", "Bearer mock-jwt-token");

    expect(res.statusCode).toEqual(404);
    expect(res.body.message).toBe("User not found");
  });
});
