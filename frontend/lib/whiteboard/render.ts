import type { BoardElement, BoardExport, BoardSnapshot, ExportOptions, Point } from './types';
import { HEIGHT, region, WIDTH } from './engine';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export const color = (e: BoardElement) => e.author === 'teacher' ? '#275fc5' : '#242424';
export function path(points: Point[]) { return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '); }
export function arrowHead(points: Point[]) {
  const [a, b] = points, angle = Math.atan2(b.y - a.y, b.x - a.x), size = 16;
  return path([{ x: b.x - size * Math.cos(angle - .5), y: b.y - size * Math.sin(angle - .5) }, b, { x: b.x - size * Math.cos(angle + .5), y: b.y - size * Math.sin(angle + .5) }]);
}
export function textLines(e: BoardElement) {
  const capacity = Math.max(1, Math.floor(e.width / 24));
  return (e.text ?? '').split('\n').flatMap(line => {
    const chars = Array.from(line), lines: string[] = [];
    for (let i = 0; i < chars.length; i += capacity) lines.push(chars.slice(i, i + capacity).join(''));
    return lines.length ? lines : [''];
  });
}
// All strings are escaped; geometry is validated by the engine. No model-supplied markup.
export function elementSvg(e: BoardElement) {
  let shape = '';
  if (e.kind === 'rectangle') shape = `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}"/>`;
  if (e.kind === 'ellipse') shape = `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" rx="${e.width / 2}" ry="${e.height / 2}"/>`;
  if (e.kind === 'stroke' || e.kind === 'arrow') shape = `<path d="${path(e.points!)}"/>${e.kind === 'arrow' ? `<path d="${arrowHead(e.points!)}"/>` : ''}`;
  if (e.kind === 'text' || e.kind === 'formula') shape = `<svg x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" overflow="hidden"><text fill="${color(e)}" stroke="none" font-family="sans-serif" font-size="24">${textLines(e).map((line, i) => `<tspan x="0" y="${26 + i * 32}">${escape(line)}</tspan>`).join('')}</text></svg>`;
  return `<g stroke="${color(e)}" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${shape}</g>`;
}
export async function exportBoard(snapshot: BoardSnapshot, options: ExportOptions = {}): Promise<BoardExport> {
  const area = region(options.region ?? { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const author = options.author ?? 'all';
  if (!['student', 'teacher', 'all'].includes(author)) throw new Error('无效导出作者');
  const maxSize = options.maxSize ?? 1200;
  if (!Number.isFinite(maxSize) || maxSize < 1 || maxSize > 2048) throw new Error('导出尺寸限 1–2048');
  const elements = snapshot.elements.filter(e => (author === 'all' || e.author === author) && e.x < area.x + area.width && e.x + e.width > area.x && e.y < area.y + area.height && e.y + e.height > area.y);
  if (!elements.length) throw new Error('区域内没有可导出的内容');
  const scale = Math.min(1, maxSize / Math.max(area.width, area.height));
  const width = Math.max(1, Math.round(area.width * scale)), height = Math.max(1, Math.round(area.height * scale));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${area.x} ${area.y} ${area.width} ${area.height}"><rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="white"/>${elements.map(elementSvg).join('')}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('白板图像导出失败')); img.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('浏览器不支持图像导出');
    ctx.drawImage(img, 0, 0);
    return { image: canvas.toDataURL('image/png'), region: area, revision: snapshot.revision, elementIds: elements.map(e => e.id), author };
  } finally { URL.revokeObjectURL(url); }
}
