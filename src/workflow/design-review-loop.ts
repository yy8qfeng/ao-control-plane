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
  designVersion: string;
  reviews: DesignReview[];
  blockedForHuman: boolean;
}

export async function runDesignReviewLoop(input: {
  requirement: Requirement;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  options: DesignReviewLoopOptions;
}): Promise<DesignReviewLoopResult> {
  let design = await input.codex.createDesign(input.requirement);
  let designVersionNumber = 1;
  const reviews: DesignReview[] = [];

  for (let round = 1; round <= input.options.maxDesignReviewRounds; round += 1) {
    const designVersion = `design-v${designVersionNumber}`;
    const review = await input.claudeCode.reviewDesign({
      workflowId: input.requirement.id,
      round,
      designVersion,
      design
    });

    reviews.push(review);

    if (review.reviewDecision === "approved") {
      return {
        approved: true,
        design,
        designVersion,
        reviews,
        blockedForHuman: false
      };
    }

    if (review.reviewDecision === "human_review_required") {
      return {
        approved: false,
        design,
        designVersion,
        reviews,
        blockedForHuman: true
      };
    }

    if (round === input.options.maxDesignReviewRounds) {
      break;
    }

    design = await input.codex.reviseDesign({
      currentDesign: design,
      review
    });
    designVersionNumber += 1;
  }

  return {
    approved: false,
    design,
    designVersion: `design-v${designVersionNumber}`,
    reviews,
    blockedForHuman: true
  };
}
