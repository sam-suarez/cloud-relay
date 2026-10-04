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
 * Renders every size in IMAGE_VARIANTS as WebP.
 *
 * `autoOrient` applies the EXIF orientation so phone photos aren't sideways.
 * sharp writes no metadata unless asked to, so EXIF (camera, GPS location) is
 * stripped from every output.
 */
export async function renderVariants(
  input: Uint8Array,
  { maxInputPixels = MAX_INPUT_PIXELS } = {},
): Promise<RenderedImage[]> {
  const source = sharp(input, { autoOrient: true, limitInputPixels: maxInputPixels });

  const variants = Object.entries(IMAGE_VARIANTS) as [ImageVariant, number][];
  return Promise.all(
    variants.map(async ([variant, size]) => {
      const { data, info } = await source
        .clone()
        // Fit inside a size × size box, keeping the aspect ratio. Never upscale.
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      return { variant, body: data, width: info.width, height: info.height, bytes: info.size };
    }),
  );
}
