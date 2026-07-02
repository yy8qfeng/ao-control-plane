import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["scripts/*.ts"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    ignores: ["dist/**", "node_modules/**"]
  }
);
