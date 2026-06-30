import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";

export interface DesignReviewLoopOptions {
  maxDesignReviewRounds: number;
  startingRound?: number;
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
  finalReviewDecision?: DesignReview["reviewDecision"];
  deferredFindings: DesignReview["findings"];
}

export async function runDesignReviewLoop(input: {
  requirement: Requirement;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  options: DesignReviewLoopOptions;
  hooks?: DesignReviewLoopHooks;
  signal?: AbortSignal;
  initialDesign?: string;
}): Promise<DesignReviewLoopResult> {
  throwIfAborted(input.signal);
  let design = input.initialDesign;
  if (!design) {
    design = await input.codex.createDesign(input.requirement, { signal: input.signal });
  }
  const reviews: DesignReview[] = [];
  const designVersion = "design-current";

  const startingRound = input.options.startingRound ?? 1;
  const finalRound = startingRound + input.options.maxDesignReviewRounds - 1;

  for (let round = startingRound; round <= finalRound; round += 1) {
    throwIfAborted(input.signal);
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

    if (review.reviewDecision === "approved" || review.reviewDecision === "defer_to_implementation") {
      return {
        approved: true,
        design,
        designVersion,
        reviews,
        blockedForHuman: false,
        finalReviewDecision: review.reviewDecision,
        deferredFindings:
          review.reviewDecision === "defer_to_implementation"
            ? review.findings.filter((finding) => finding.status === "unresolved")
            : []
      };
    }

    if (round === finalRound) {
      break;
    }

    await input.hooks?.onRevisionStart?.({ round, review });
    design = await input.codex.reviseDesign({
      currentDesign: design,
      review
    }, { signal: input.signal });
  }

  return {
    approved: false,
    design,
    designVersion,
    reviews,
    blockedForHuman: true,
    finalReviewDecision: reviews.at(-1)?.reviewDecision,
    deferredFindings: []
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Workflow was stopped by user");
  }
}
