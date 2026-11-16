export interface MaskPoint { x: number; y: number }
export interface MaskStroke { tool: 'brush' | 'erase' | 'rectangle'; points: MaskPoint[]; size: number }

/** Shapes are normalized to the source image, independent of preview size or device pixel ratio. */
export function renderImageMask(width: number, height: number, strokes: MaskStroke[], feather = 0): HTMLCanvasElement {
  const shape = document.createElement('canvas'); shape.width = width; shape.height = height;
  const ctx = shape.getContext('2d')!;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.globalCompositeOperation = stroke.tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = '#ffffff';
    const first = stroke.points[0], last = stroke.points[stroke.points.length - 1];
    if (stroke.tool === 'rectangle') ctx.fillRect(Math.min(first.x, last.x) * width, Math.min(first.y, last.y) * height, Math.abs(last.x - first.x) * width, Math.abs(last.y - first.y) * height);
    else {
      ctx.lineWidth = stroke.size * Math.min(width, height); ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(first.x * width, first.y * height);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * width, point.y * height);
      if (stroke.points.length > 1) ctx.stroke();
      else { ctx.arc(first.x * width, first.y * height, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  const softened = document.createElement('canvas'); softened.width = width; softened.height = height;
  const soft = softened.getContext('2d')!;
  // Clip blur to the painted footprint: feathering never expands the editable region.
  if (feather > 0) soft.filter = `blur(${feather * Math.min(width, height)}px)`;
  soft.drawImage(shape, 0, 0); soft.filter = 'none'; soft.globalCompositeOperation = 'destination-in'; soft.drawImage(shape, 0, 0);
  const mask = document.createElement('canvas'); mask.width = width; mask.height = height;
  const output = mask.getContext('2d')!; output.fillStyle = '#000000'; output.fillRect(0, 0, width, height); output.drawImage(softened, 0, 0);
  return mask;
}

export function maskHasSelection(mask: HTMLCanvasElement): boolean {
  const data = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

export function paintMaskOverlay(target: HTMLCanvasElement, mask: HTMLCanvasElement, color: string): void {
  target.width = mask.width; target.height = mask.height;
  const ctx = target.getContext('2d')!, pixels = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height);
  for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i + 3] = pixels.data[i];
  ctx.putImageData(pixels, 0, 0); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = color; ctx.fillRect(0, 0, target.width, target.height); ctx.globalCompositeOperation = 'source-over';
}

export function imageMaskGuide(source: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const guide = document.createElement('canvas'); guide.width = source.width; guide.height = source.height;
  const ctx = guide.getContext('2d')!; ctx.drawImage(source, 0, 0);
  const overlay = document.createElement('canvas'); paintMaskOverlay(overlay, mask, '#ff0000');
  ctx.globalAlpha = 0.4; ctx.drawImage(overlay, 0, 0); return guide;
}

export async function loadMaskImage(uri: string): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Cannot decode an image for mask editing')); image.src = uri; });
  if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) throw new Error('Mask editing supports images up to 32 megapixels');
  return image;
}

export async function inspectImageMask(sourceUri: string, maskUri: string) {
  const [source, mask] = await Promise.all([loadMaskImage(sourceUri), loadMaskImage(maskUri)]);
  if (source.naturalWidth !== mask.naturalWidth || source.naturalHeight !== mask.naturalHeight) throw new Error('The image and mask dimensions do not match');
  const canvas = document.createElement('canvas'); canvas.width = mask.naturalWidth; canvas.height = mask.naturalHeight;
  canvas.getContext('2d')!.drawImage(mask, 0, 0);
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  let selected = false;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const p = pixels.data;
    if (p[i] !== p[i + 1] || p[i] !== p[i + 2] || p[i + 3] !== 255) throw new Error('The mask must be opaque grayscale: white edits, black preserves');
    if (p[i]) selected = true;
  }
  if (!selected) throw new Error('The edit mask is empty');
  return { source, mask: pixels };
}

/** Premultiplied blending; every unselected pixel, including its alpha, is copied exactly. */
export function compositeMaskedPixels(source: Uint8ClampedArray, candidate: Uint8ClampedArray, mask: Uint8ClampedArray): Uint8ClampedArray {
  if (source.length !== candidate.length || source.length !== mask.length || source.length % 4) throw new Error('Masked image pixel buffers do not match');
  const output = new Uint8ClampedArray(source);
  for (let i = 0; i < source.length; i += 4) {
    const amount = mask[i] / 255;
    if (!amount) continue;
    const a = source[i + 3] / 255 * (1 - amount), b = candidate[i + 3] / 255 * amount, alpha = a + b;
    for (let c = 0; c < 3; c++) output[i + c] = alpha ? (source[i + c] * a + candidate[i + c] * b) / alpha : 0;
    output[i + 3] = alpha * 255;
  }
  return output;
}

export async function compositeMaskedImage(sourceUri: string, candidateUri: string, maskUri: string) {
  const [{ source, mask }, candidate] = await Promise.all([inspectImageMask(sourceUri, maskUri), loadMaskImage(candidateUri)]);
  const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0); const original = ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(candidate, 0, 0, canvas.width, canvas.height);
  const generated = ctx.getImageData(0, 0, canvas.width, canvas.height);
  original.data.set(compositeMaskedPixels(original.data, generated.data, mask.data)); ctx.putImageData(original, 0, 0);
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}
