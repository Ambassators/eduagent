import type { PageRect, PDFPointer } from '../shared';

type Point = { x: number; y: number };
export type PointerLayout = { dot: Point; arrow: string };

/** Keep the orb, its close button, and its arrowhead in blank page space. */
export function layoutPDFPointer(pointer: PDFPointer, sheet: HTMLElement, width: number, height: number): PointerLayout | null {
  const bounds=sheet.getBoundingClientRect();
  const target={x:pointer.target.x*width,y:pointer.target.y*height,width:pointer.target.width*width,height:pointer.target.height*height};
  const obstacles:PageRect[]=[target];
  for(const span of sheet.querySelectorAll('.textLayer span')) {
    if(!span.textContent?.trim())continue;
    const range=document.createRange();range.selectNodeContents(span);
    for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0)obstacles.push({x:rect.x-bounds.x,y:rect.y-bounds.y,width:rect.width,height:rect.height});
  }
  // 42px covers the arrow tip; the extra clearance keeps every part off text.
  const clearance=50;
  const safe=({x,y}:Point)=>x>=clearance&&y>=clearance&&x<=width-clearance&&y<=height-clearance&&
    !obstacles.some(r=>x+clearance>r.x&&x-clearance<r.x+r.width&&y+clearance>r.y&&y-clearance<r.y+r.height);
  const preferred={x:pointer.dot.x*width,y:pointer.dot.y*height};
  let dot:Point|null=safe(preferred)?preferred:null;
  if(!dot) {
    const center={x:target.x+target.width/2,y:target.y+target.height/2};
    const candidates:Point[]=[
      {x:target.x+target.width+64,y:center.y},{x:target.x-64,y:center.y},
      {x:center.x,y:target.y-64},{x:center.x,y:target.y+target.height+64},
    ];
    for(let y=clearance;y<=height-clearance;y+=24)for(let x=clearance;x<=width-clearance;x+=24)candidates.push({x,y});
    let best=Infinity;
    for(const candidate of candidates) {
      if(!safe(candidate))continue;
      const score=Math.hypot(candidate.x-preferred.x,candidate.y-preferred.y)+.2*Math.hypot(candidate.x-center.x,candidate.y-center.y);
      if(score<best){best=score;dot=candidate;}
    }
  }
  // A page without enough blank space keeps voice available in the main panel.
  if(!dot)return null;
  const end={x:Math.max(target.x,Math.min(target.x+target.width,dot.x)),y:Math.max(target.y,Math.min(target.y+target.height,dot.y))};
  const distance=Math.hypot(end.x-dot.x,end.y-dot.y)||1,dx=(end.x-dot.x)/distance,dy=(end.y-dot.y)/distance;
  const tip={x:dot.x+dx*42,y:dot.y+dy*42},base={x:dot.x+dx*30,y:dot.y+dy*30};
  return {dot,arrow:`M ${tip.x} ${tip.y} L ${base.x-dy*7} ${base.y+dx*7} L ${base.x+dy*7} ${base.y-dx*7} Z`};
}
