const AICallLog = require("../src/models/AICallLog");

describe("AICallLog provider registry", () => {
  it.each(["openai", "anthropic", "gemini", "deepseek", "moonshot"])(
    "accepts dispatcher provider %s",
    (provider) => {
      const row = new AICallLog({ operation: "test", provider });
      expect(row.validateSync()).toBeUndefined();
    }
  );
});
