import { z } from "zod";

export const aoRoleSchema = z.enum([
  "architect",
  "reviewer",
  "ui-designer",
  "frontend-senior",
  "frontend-junior",
  "backend-senior",
  "backend-junior",
  "qa",
  "docs",
  "second-opinion",
  "frontend",
  "backend"
]);

export type AoRole = z.infer<typeof aoRoleSchema>;

export const preferredExecutionRoles: AoRole[] = [
  "architect",
  "reviewer",
  "ui-designer",
  "frontend-senior",
  "frontend-junior",
  "backend-senior",
  "backend-junior",
  "qa",
  "docs",
  "second-opinion"
];
