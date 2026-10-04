import { IMAGE_VARIANTS, type ImageVariant } from '@cloud-relay/shared';
import sharp from 'sharp';

/**
 * Refuse images over ~50 megapixels before decoding them. A small, highly
 * compressed PNG can decode to gigabytes of pixels and run the function out
 * of memory (a "decompression bomb"). Phone photos are well under this.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

export interface RenderedImage {
  variant: ImageVariant;
  body: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/**
 * The copy sent to Rekognition. Rekognition only accepts JPEG or PNG (not the
 * WebP we store), at most 5 MB as bytes, so it gets a display-sized JPEG that
 * lives only in memory.
 */
export const ANALYSIS_SIZE = IMAGE_VARIANTS.display;

export interface RenderedImages {
  /** Every size in IMAGE_VARIANTS, as WebP, for the processed bucket. */
  variants: RenderedImage[];
  /** JPEG for Rekognition. Never stored. */
  analysis: Buffer;
}

/**
 * Decodes the upload once and renders every size in IMAGE_VARIANTS as WebP,
 * plus the JPEG for Rekognition.
 *
 * `autoOrient` applies the EXIF orientation so phone photos aren't sideways.
 * sharp writes no metadata unless asked to, so EXIF (camera, GPS location) is
 * stripped from every output.
 */
export async function renderImages(
  input: Uint8Array,
  { maxInputPixels = MAX_INPUT_PIXELS } = {},
): Promise<RenderedImages> {
  const source = sharp(input, { autoOrient: true, limitInputPixels: maxInputPixels });
  // Fit inside a size × size box, keeping the aspect ratio. Never upscale.
  const fit = (size: number) =>
    source.clone().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });

  const sizes = Object.entries(IMAGE_VARIANTS) as [ImageVariant, number][];
  const [variants, analysis] = await Promise.all([
    Promise.all(
      sizes.map(async ([variant, size]) => {
        const { data, info } = await fit(size)
          .webp({ quality: 80 })
          .toBuffer({ resolveWithObject: true });
        return { variant, body: data, width: info.width, height: info.height, bytes: info.size };
      }),
    ),
    fit(ANALYSIS_SIZE).jpeg({ quality: 85 }).toBuffer(),
  ]);
  return { variants, analysis };
}
