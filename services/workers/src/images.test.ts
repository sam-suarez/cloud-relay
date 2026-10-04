import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderImages } from './images.ts';

function jpeg(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#3b82f6' } }).jpeg();
}

describe('renderImages', () => {
  it('renders a 1280 px display image and a 320 px thumbnail as WebP', async () => {
    const { variants: images } = await renderImages(await jpeg(3000, 2000).toBuffer());

    expect(images.map(({ variant, width, height }) => ({ variant, width, height }))).toEqual([
      { variant: 'display', width: 1280, height: 853 },
      { variant: 'thumb', width: 320, height: 213 },
    ]);
    for (const image of images) {
      expect((await sharp(image.body).metadata()).format).toBe('webp');
      expect(image.bytes).toBe(image.body.length);
    }
  });

  it('renders a display-sized JPEG for Rekognition, which does not accept WebP', async () => {
    const { analysis } = await renderImages(await jpeg(3000, 2000).toBuffer());
    const output = await sharp(analysis).metadata();

    expect(output).toMatchObject({ format: 'jpeg', width: 1280, height: 853 });
    expect(analysis.length).toBeLessThan(5 * 1024 * 1024); // Rekognition's limit for bytes
  });

  it('never upscales a small image', async () => {
    const {
      variants: [display, thumb],
    } = await renderImages(await jpeg(200, 100).toBuffer());

    expect([display?.width, display?.height]).toEqual([200, 100]);
    expect([thumb?.width, thumb?.height]).toEqual([200, 100]);
  });

  it('applies the EXIF orientation, then strips all metadata', async () => {
    // A landscape-encoded photo whose EXIF says "rotate 90°", like a phone held upright.
    const input = await jpeg(400, 200).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const { variants, analysis } = await renderImages(input);

    for (const body of [variants[0]?.body, analysis]) {
      const output = await sharp(body).metadata();
      expect([output.width, output.height]).toEqual([200, 400]);
      expect(output.exif).toBeUndefined();
    }
  });

  it('refuses images over the pixel limit before decoding them', async () => {
    const input = await jpeg(400, 300).toBuffer(); // 120,000 pixels

    await expect(renderImages(input, { maxInputPixels: 100_000 })).rejects.toThrow(/pixel limit/i);
  });
});
