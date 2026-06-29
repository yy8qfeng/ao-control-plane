import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";

export interface DesignReviewLoopOptions {
  maxDesignReviewRounds: number;
}

export interface DesignReviewLoopResult {
  approved: boolean;
  design: string;
  reviews: DesignReview[];
}

export async function runDesignReviewLoop(input: {
  requirement: Requirement;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  options: DesignReviewLoopOptions;
}): Promise<DesignReviewLoopResult> {
  let design = await input.codex.createDesign(input.requirement);
  const reviews: DesignReview[] = [];

  for (let round = 1; round <= input.options.maxDesignReviewRounds; round += 1) {
    const review = await input.claudeCode.reviewDesign({
      requirementId: input.requirement.id,
      round,
      design
    });

    reviews.push(review);

    if (review.conclusion === "approved") {
      return {
        approved: true,
        design,
        reviews
      };
    }

    design = await input.codex.reviseDesign({
      currentDesign: design,
      review
    });
  }

  return {
    approved: false,
    design,
    reviews
  };
}
