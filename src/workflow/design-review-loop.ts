import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";

export interface DesignReviewLoopOptions {
  maxDesignReviewRounds: number;
}

export interface DesignReviewLoopHooks {
  onDesign?: (input: { designVersion: string; design: string }) => Promise<void> | void;
  onReviewStart?: (input: { round: number; designVersion: string }) => Promise<void> | void;
  onReview?: (input: { review: DesignReview }) => Promise<void> | void;
  onRevisionStart?: (input: { round: number; review: DesignReview }) => Promise<void> | void;
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
  hooks?: DesignReviewLoopHooks;
  signal?: AbortSignal;
}): Promise<DesignReviewLoopResult> {
  throwIfAborted(input.signal);
  let design = await input.codex.createDesign(input.requirement, { signal: input.signal });
  let designVersionNumber = 1;
  const reviews: DesignReview[] = [];

  for (let round = 1; round <= input.options.maxDesignReviewRounds; round += 1) {
    throwIfAborted(input.signal);
    const designVersion = `design-v${designVersionNumber}`;
    await input.hooks?.onDesign?.({ designVersion, design });
    await input.hooks?.onReviewStart?.({ round, designVersion });
    const review = await input.claudeCode.reviewDesign({
      workflowId: input.requirement.id,
      round,
      designVersion,
      design
    }, { signal: input.signal });

    reviews.push(review);
    await input.hooks?.onReview?.({ review });

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

    await input.hooks?.onRevisionStart?.({ round, review });
    design = await input.codex.reviseDesign({
      currentDesign: design,
      review
    }, { signal: input.signal });
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Workflow was stopped by user");
  }
}
