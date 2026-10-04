import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderVariants } from './images.ts';

function jpeg(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#3b82f6' } }).jpeg();
}

describe('renderVariants', () => {
  it('renders a 1280 px display image and a 320 px thumbnail as WebP', async () => {
    const images = await renderVariants(await jpeg(3000, 2000).toBuffer());

    expect(images.map(({ variant, width, height }) => ({ variant, width, height }))).toEqual([
      { variant: 'display', width: 1280, height: 853 },
      { variant: 'thumb', width: 320, height: 213 },
    ]);
    for (const image of images) {
      expect((await sharp(image.body).metadata()).format).toBe('webp');
      expect(image.bytes).toBe(image.body.length);
    }
  });

  it('never upscales a small image', async () => {
    const [display, thumb] = await renderVariants(await jpeg(200, 100).toBuffer());

    expect([display?.width, display?.height]).toEqual([200, 100]);
    expect([thumb?.width, thumb?.height]).toEqual([200, 100]);
  });

  it('applies the EXIF orientation, then strips all metadata', async () => {
    // A landscape-encoded photo whose EXIF says "rotate 90°", like a phone held upright.
    const input = await jpeg(400, 200).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const [display] = await renderVariants(input);
    const output = await sharp(display?.body).metadata();

    expect([output.width, output.height]).toEqual([200, 400]);
    expect(output.exif).toBeUndefined();
  });

  it('refuses images over the pixel limit before decoding them', async () => {
    const input = await jpeg(400, 300).toBuffer(); // 120,000 pixels

    await expect(renderVariants(input, { maxInputPixels: 100_000 })).rejects.toThrow(
      /pixel limit/i,
    );
  });
});
