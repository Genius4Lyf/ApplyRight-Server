const js = require("@eslint/js");
const globals = require("globals");
const prettierPlugin = require("eslint-plugin-prettier");
const prettierConfig = require("eslint-config-prettier");
const jestPlugin = require("eslint-plugin-jest");

module.exports = [
  {
    ignores: ["node_modules/**", ".cache/**", "logs/**", "uploads/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      prettier: prettierPlugin,
      jest: jestPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,
      "prettier/prettier": "error",
      "no-console": "warn",
      "no-unused-vars": "warn",
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
      indent: "off",
      quotes: "off",
      semi: "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // Puppeteer: the callback passed to page.evaluate() is serialised and executed
    // INSIDE the page, where `document` exists and Node globals do not. Declaring it here
    // rather than disabling no-undef, because no-undef is the one rule that catches a real
    // crash — a symbol referenced but never defined, which throws the moment that line
    // runs. Exactly such a bug was hiding among these two false positives elsewhere in the
    // repo, indistinguishable from them.
    files: ["src/services/pdf.service.js", "src/services/screenshot.service.js"],
    languageOptions: { globals: { document: "readonly" } },
  },
];
