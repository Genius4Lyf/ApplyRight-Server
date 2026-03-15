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
];
