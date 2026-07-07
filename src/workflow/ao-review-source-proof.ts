export interface ReviewerSourceFields {
  source?: string;
  aoSessionId?: string;
  decidedBy?: string;
  reviewerSessionId?: string;
  reviewerIndependence?: Record<string, unknown>;
}

export function readReviewerSourceFields(json: Record<string, unknown>): ReviewerSourceFields {
  return {
    source: readString(json.source),
    aoSessionId: readString(json.aoSessionId),
    decidedBy: readString(json.decidedBy),
    reviewerSessionId: readString(json.reviewerSessionId),
    reviewerIndependence: isRecord(json.reviewerIndependence)
      ? json.reviewerIndependence
      : undefined
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
