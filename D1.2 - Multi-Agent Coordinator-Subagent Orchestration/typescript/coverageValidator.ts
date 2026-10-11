/**
 * Coverage checklist and the validator the coordinator runs on its OWN decomposition.
 *
 * Sample question 7: every subagent did its job, yet the report missed music, writing and film,
 * because the coordinator only ever assigned visual-arts subtopics. Downstream agents cannot
 * notice what they were never asked to research, so the check belongs at the coordinator, right
 * after it decomposes the topic and before anything is delegated.
 *
 * The checklist is a small hand-written taxonomy. In production it could come from a domain
 * taxonomy, a client brief, or a separate "list the dimensions of this topic" call.
 */
import type { Subtopic } from "./researchTeam.ts";

/** topic keyword -> { dimension: keywords that mean a subtopic covers it } */
export const REQUIRED_DIMENSIONS: Record<string, Record<string, string[]>> = {
  "creative industries": {
    visual_arts: ["visual art", "digital art", "graphic design", "photography", "illustration"],
    music: ["music"],
    writing: ["writing", "publishing", "literature", "journalism"],
    film: ["film", "video", "cinema", "animation", "visual effects", "vfx"],
  },
};

export interface CoverageReport {
  has_checklist: boolean;
  required: string[];
  slice_dimensions: Record<string, string[]>;
  missing: string[];
  overlaps: Record<string, string[]>;
  ok: boolean;
}

export function checklistFor(topic: string): Record<string, string[]> {
  const lowered = topic.toLowerCase();
  const key = Object.keys(REQUIRED_DIMENSIONS).find((k) => lowered.includes(k));
  return key ? REQUIRED_DIMENSIONS[key] : {};
}

export function dimensionsOf(focus: string, checklist: Record<string, string[]>): string[] {
  const lowered = focus.toLowerCase();
  return Object.entries(checklist)
    .filter(([, keywords]) => keywords.some((k) => lowered.includes(k)))
    .map(([dim]) => dim);
}

/**
 * Check a decomposition against the topic's required dimensions.
 *   missing  - required dimensions no subtopic covers (incomplete research)
 *   overlaps - dimensions claimed by several subtopics (agents will return the same sources)
 */
export function validateCoverage(topic: string, subtopics: Subtopic[]): CoverageReport {
  const checklist = checklistFor(topic);
  const sliceDims: Record<string, string[]> = {};
  for (const st of subtopics) sliceDims[st.id] = dimensionsOf(st.focus, checklist);
  const missing: string[] = [];
  const overlaps: Record<string, string[]> = {};
  for (const dim of Object.keys(checklist)) {
    const ids = Object.keys(sliceDims).filter((sid) => sliceDims[sid].includes(dim));
    if (ids.length === 0) missing.push(dim);
    if (ids.length > 1) overlaps[dim] = ids;
  }
  return {
    has_checklist: Object.keys(checklist).length > 0,
    required: Object.keys(checklist),
    slice_dimensions: sliceDims,
    missing,
    overlaps,
    ok: missing.length === 0 && Object.keys(overlaps).length === 0,
  };
}

/** Validator result as a message back to the coordinator (machine-readable parts in tags). */
export function feedbackFor(report: CoverageReport): string {
  return (
    "Your decomposition failed the coverage check.\n" +
    `<missing>${JSON.stringify(report.missing)}</missing>\n` +
    `<overlaps>${JSON.stringify(report.overlaps)}</overlaps>\n` +
    "Revise the subtopics: give every missing dimension its own subtopic and merge overlapping ones."
  );
}
