export function buildRequirementDescription(input: {
  description: string;
  discussion?: string;
}): string {
  return [input.description.trim(), formatDiscussion(input.discussion)].filter(Boolean).join("\n\n");
}

export function formatDiscussion(discussion: string | undefined): string {
  const trimmed = discussion?.trim();
  return trimmed ? `讨论记录：\n${trimmed}` : "";
}
