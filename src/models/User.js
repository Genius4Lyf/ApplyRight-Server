const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Please add an email"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: function (v) {
          // Comprehensive email regex that validates proper email format
          // and checks for common valid TLDs
          return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|org|net|edu|gov|mil|co|io|ai|tech|dev|app|uk|ca|au|de|fr|jp|cn|in|br|mx|es|it|nl|se|no|dk|fi|ch|at|be|ie|nz|sg|hk|my|ph|th|vn|id|kr|tw|za|ae|sa|eg|ng|ke|gh|tz|ug|zm|zw|bw|mw|na|sz|ls|gm|sl|lr|sn|ml|bf|ne|td|cf|cm|ga|cg|cd|ao|mz|mg|sc|mu|re|yt|km|dj|so|et|er|sd|ss|ly|tn|dz|ma|eh|mr|cv|st|gq|gw|bi|rw|vu|fj|pg|sb|nc|pf|ws|to|tv|ki|nr|fm|mh|pw|mp|gu|as|vi|pr|do|jm|tt|bb|gd|lc|vc|ag|kn|dm|bs|ky|bm|tc|vg|ai|ms|gl|fo|is|li|mc|sm|va|ad|mt|cy|tr|gr|bg|ro|hu|cz|sk|pl|ua|by|ru|lt|lv|ee|md|ge|am|az|kz|uz|tm|kg|tj|mn|kp|mm|la|kh|bn|mv|bt|np|lk|bd|pk|af|ir|iq|sy|lb|jo|il|ps|ye|om|kw|bh|qa|info|biz|name|pro|coop|aero|museum|travel|jobs|mobi|tel|xxx|asia|cat|post|xxx)$/i.test(
            v,
          );
        },
        message: (props) =>
          `${props.value} is not a valid email address with a recognized domain!`,
      },
    },
    password: {
      type: String,
      required: true,
    },
    plan: {
      type: String,
      enum: ["free", "paid"],
      default: "free",
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    credits: {
      type: Number,
      default: 20, // Free starting credits
    },
    adStreak: {
      current: { type: Number, default: 0 },
      longest: { type: Number, default: 0 },
      lastWatchDate: { type: Date, default: null },
    },
    unlockedTemplates: [String],
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // Allows null/undefined values to not violate uniqueness (though we generate for all)
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    referralCount: {
      type: Number,
      default: 0,
    },
    firstName: {
      type: String,
      default: "",
    },
    lastName: {
      type: String,
      default: "",
    },
    otherName: {
      type: String,
      default: "",
    },
    phone: {
      type: String,
      required: [true, "Please add a phone number"],
      unique: true,
      trim: true,
      validate: {
        validator: function (v) {
          // E.164 format: +[country code][number]
          // Must start with + followed by 1-15 digits
          return /^\+[1-9]\d{1,14}$/.test(v);
        },
        message: (props) =>
          `${props.value} is not a valid international phone number! Please include the country code (e.g., +1234567890)`,
      },
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    portfolioUrl: {
      type: String,
      default: "",
    },
    linkedinUrl: {
      type: String,
      default: "",
    },
    currentJobTitle: {
      type: String,
      default: "",
    },
    currentStatus: {
      type: String,
      enum: ["student", "graduate", "professional", "other"],
    },
    education: {
      university: String,
      discipline: String,
      graduationYear: String,
    },
    careerGoals: [
      {
        type: String,
      },
    ],
    skills: [
      {
        type: String,
      },
    ],
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    settings: {
      autoGenerateAnalysis: {
        type: Boolean,
        default: false,
      },
      showOnboardingTutorials: {
        type: Boolean,
        default: true,
      },
      hideSkillsAiPrompt: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("User", userSchema);
