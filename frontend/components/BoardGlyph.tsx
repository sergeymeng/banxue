import type { BoardElement } from '@/lib/whiteboard/types';
import { arrowHead, color, path, textLines } from '@/lib/whiteboard/render';
export default function BoardGlyph({ element: e }: { element: BoardElement }) {
  return <g data-element-id={e.id} data-author={e.author} data-kind={e.kind} stroke={color(e)} fill="none" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <title>{e.author === 'teacher' ? '老师板书' : '学生书写'}：{e.text || e.kind}</title>
    {e.kind === 'rectangle' && <rect x={e.x} y={e.y} width={e.width} height={e.height} />}
    {e.kind === 'ellipse' && <ellipse cx={e.x + e.width / 2} cy={e.y + e.height / 2} rx={e.width / 2} ry={e.height / 2} />}
    {(e.kind === 'stroke' || e.kind === 'arrow') && <path d={path(e.points!)} />}
    {e.kind === 'arrow' && <path d={arrowHead(e.points!)} />}
    {(e.kind === 'text' || e.kind === 'formula') && <svg x={e.x} y={e.y} width={e.width} height={e.height} overflow="hidden"><text fill={color(e)} stroke="none" fontFamily="sans-serif" fontSize={24}>{textLines(e).map((line, i) => <tspan key={i} x={0} y={26 + i * 32}>{line}</tspan>)}</text></svg>}
  </g>;
}
