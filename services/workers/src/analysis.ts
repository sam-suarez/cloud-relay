import {
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import type { ImageLabel, ModerationLabel } from '@cloud-relay/shared';

const rekognition = new RekognitionClient({});

/** Moderation labels below this confidence are ignored. Also the reject threshold. */
export const MODERATION_MIN_CONFIDENCE = 60;

/**
 * Top-level (level 1) moderation categories that get an image rejected. The
 * others (Swimwear or Underwear, Drugs & Tobacco, Alcohol, Rude Gestures,
 * Gambling) are allowed and only reported.
 */
export const BLOCKED_CATEGORIES: ReadonlySet<string> = new Set([
  'Explicit',
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Violence',
  'Visually Disturbing',
  'Hate Symbols',
]);

export const MAX_LABELS = 10;
export const LABEL_MIN_CONFIDENCE = 75;

/**
 * Label categories DetectLabels leaves out. "Person Description" is guesses
 * like Adult, Male or Man, which read badly on a visitor's own photo.
 */
export const EXCLUDED_LABEL_CATEGORIES = ['Person Description'];

export interface ModerationResult {
  /** Rekognition's moderation model version, e.g. "7.0". */
  model: string;
  labels: ModerationLabel[];
  /** BLOCKED_CATEGORIES that matched. Empty means the image may be shown. */
  blocked: string[];
}

/** DetectModerationLabels on the in-memory JPEG. */
export async function moderate(jpeg: Uint8Array): Promise<ModerationResult> {
  const response = await rekognition.send(
    new DetectModerationLabelsCommand({
      Image: { Bytes: jpeg },
      MinConfidence: MODERATION_MIN_CONFIDENCE,
    }),
  );
  const labels = (response.ModerationLabels ?? []).map((label) => ({
    name: label.Name ?? '',
    parentName: label.ParentName ?? '',
    level: label.TaxonomyLevel ?? 1,
    confidence: round(label.Confidence ?? 0),
  }));
  return {
    model: response.ModerationModelVersion ?? 'unknown',
    labels,
    blocked: blockedCategories(labels),
  };
}

/**
 * The blocked top-level categories among `labels`. Each label is checked
 * together with its parents (e.g. Weapons → Violence), in case Rekognition
 * returned a detailed label without its top-level one.
 */
export function blockedCategories(labels: readonly ModerationLabel[]): string[] {
  const parentOf = new Map(labels.map((label) => [label.name, label.parentName]));
  const blocked = new Set<string>();
  for (const label of labels) {
    // Walks up the taxonomy; a top-level label's parent is "".
    for (let name: string | undefined = label.name; name; name = parentOf.get(name)) {
      if (BLOCKED_CATEGORIES.has(name)) blocked.add(name);
    }
  }
  return [...blocked].sort();
}

export interface LabelResult {
  model: string;
  labels: ImageLabel[];
}

/** DetectLabels on the in-memory JPEG: the top MAX_LABELS things in the photo. */
export async function detectLabels(jpeg: Uint8Array): Promise<LabelResult> {
  const response = await rekognition.send(
    new DetectLabelsCommand({
      Image: { Bytes: jpeg },
      MaxLabels: MAX_LABELS,
      MinConfidence: LABEL_MIN_CONFIDENCE,
      // Only labels. IMAGE_PROPERTIES (colors, quality) is billed extra.
      Features: ['GENERAL_LABELS'],
      Settings: { GeneralLabels: { LabelCategoryExclusionFilters: EXCLUDED_LABEL_CATEGORIES } },
    }),
  );
  return {
    model: response.LabelModelVersion ?? 'unknown',
    labels: (response.Labels ?? []).map((label) => ({
      name: label.Name ?? '',
      confidence: round(label.Confidence ?? 0),
    })),
  };
}

/** One decimal is plenty for display, and keeps the DynamoDB item small. */
function round(confidence: number): number {
  return Math.round(confidence * 10) / 10;
}
