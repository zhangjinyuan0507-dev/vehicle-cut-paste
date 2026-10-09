// 红外车辆拼贴工具 v2 主逻辑（app.js）
// 与 v1 的差异：
//  1) 车辆素材换成透明渲染车，并按「模式」分成两套互不相干的素材库与类别表：
//       base 基础四类    ：car1 装甲车 / car2 卡车 / car3 轿车 / car4 皮卡（66 个素材，类别 ID 0~3）
//       incr 类增量新四类：radar_vehicle 雷达车 / military_fuel_tanker 军用油罐车 /
//                          bridge_layer 轮式架桥车 / military_motorcycle 军用越野摩托车（24 个素材，类别 ID 4~7）
//     类别表由 classes.js 提供（官方口径：旧类 0~3 不变，新类只能从 4 起追加）；
//  2) v1 把 car2/car4 的中文名写反了（显示 car2 皮卡、car4 卡车），v2 按官方类别表修正；
//  3) 标注框按车辆**实体可见范围**（素材 alpha 外接框）计算，而不是整张素材画布——v1 的框里大半是透明边距；
//  4) 摆放时按类别自动挑选车型/视角（同类别不连续重复），面板显示当前与下一个素材；
//  5) 素材按实体居中归一化，同一「大小」滑块在不同车型/视角上含义一致。
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const leftEl = document.getElementById('canvasWrap');

let bgFiles = [], curIdx = -1, imgPlacements = {};
let bg = null, placements = [], vehImgs = {}, manualCls = -1, lastSiByCls = {}, lastPlacedSiByCls = {};
let selected = -1, drag = null, zoom = 1, baseZoom = 1, pan = null, pending = null, tx = 0, ty = 0, resize = null, rotDrag = null, bgCanvas = null, plan = null, savedMap = {}, dirtyMap = {}, defSize = 0.06, defRot = 0;
let hideLabels = false, saveRoot = null;
let mode = 'base';                 // 类别组：base（基础四类）| incr（类增量新四类）
let spectrum = 'ir';               // 光谱：ir（红外）| vis（可见光）
let palFilter = 'all';             // 可见光配色筛选：all | desert_camo | olive_green（红外固定 ir）
let SPRITES = [];                  // 已加载素材的合集；si 为全局下标，切换模式/光谱都不会错位
const state = { size:0.06, bright:0.8, contrast:1, blur:0.2, rot:0 };
// CLS / CLS_CN / CLS_ID / MODES 由 classes.js 定义；SPECTRA / PALETTES / SPRITE_GROUPS 由 sprite_groups.js 定义

function loadImage(src){ return new Promise(res=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; }); }

/* ===== 类别组（模式）===== */
function modeInfo(m){ return MODES[m] || MODES.base; }
function modeLabel(m){ return modeInfo(m).label || m; }
function modeClasses(m){ return modeInfo(m).classes || []; }
function modeClassIds(m){ return modeClasses(m).map(k=>CLS_ID[k]); }
function classMode(ci){ return ci<=3 ? 'base' : 'incr'; }
function otherMode(m){ return m==='base' ? 'incr' : 'base'; }
function spectrumLabel(sp){ const s=SPECTRA[sp||spectrum]; return (s&&s.label)||(sp||spectrum); }
/* 某光谱/配色下某个类别组的素材数（用分组清单的 byClass 统计，不依赖是否已加载） */
function modeSpriteCount(sp, m, pal){
  const want=modeClasses(m); let n=0;
  groupsNeeded(sp, pal||palFilter).forEach(k=>{ const g=SPRITE_GROUPS[k];
    want.forEach(cl=>{ n += (g.byClass && g.byClass[cl]) || 0; }); });
  return n;
}
/* 已加载进内存的素材数（按光谱/配色过滤） */
function poolSize(){ let n=0; for(const s of SPRITES) if(spriteMatches(s)) n++; return n; }

/* ===== 素材分组：按光谱/配色分文件，按需懒加载 ===== */
function groupKeys(){ return Object.keys(SPRITE_GROUPS || {}); }
/* 取某个分组已加载的素材数组（生成文件用 var 声明，可通过 window[变量名] 动态取用） */
function groupArray(k){ const g=SPRITE_GROUPS[k]; if(!g) return null; const a=window[g.var]; return Array.isArray(a)? a : null; }
function rebuildSprites(){
  const list=[];
  groupKeys().forEach(k=>{ const a=groupArray(k); if(a) list.push.apply(list,a); });
  SPRITES=list;
}
/* 当前「光谱 + 配色」需要哪些分组 */
function groupsNeeded(sp, pal){
  return groupKeys().filter(k=>{
    const g=SPRITE_GROUPS[k];
    if(!g.count || g.spectrum!==sp) return false;
    if(sp==='vis' && pal && pal!=='all' && g.palette!==pal) return false;
    return true;
  });
}
function loadScriptOnce(src){ return new Promise((res,rej)=>{ const sc=document.createElement('script'); sc.src=src; sc.onload=()=>res(true); sc.onerror=()=>rej(new Error('无法加载 '+src)); document.head.appendChild(sc); }); }
async function ensureGroups(sp, pal){
  const need=groupsNeeded(sp, pal).filter(k=>!groupArray(k));
  for(const k of need){
    setSaveStatus('正在加载「'+SPRITE_GROUPS[k].label+'」素材…');
    await loadScriptOnce(SPRITE_GROUPS[k].file+'?v=2');
  }
  if(need.length) rebuildSprites();
  return need.length;
}
/* 只加载当前「光谱+配色」范围内的素材图片（图片缓存按全局下标，多套可共存） */
async function loadPoolImages(){
  let n=0;
  for(let i=0;i<SPRITES.length;i++){ const s=SPRITES[i]; if(!spriteMatches(s) || vehImgs[i]) continue; const im=await loadImage(s.src); if(im) vehImgs[i]=im; n++; }
  return n;
}
async function initVehicles(){ rebuildSprites(); await loadPoolImages(); }
function spriteMatches(sp){ return sp.sp===spectrum && (spectrum!=='vis' || palFilter==='all' || sp.pal===palFilter); }
function spriteOf(p){ return SPRITES[p.si] || null; }
function clsOf(p){ const s=spriteOf(p); return s? s.ci : 0; }
function clsName(p){ return CLS[clsOf(p)]; }
function clsCn(ci){ return CLS_CN[CLS[ci]] || ''; }
function isVis(sp){ return sp && sp.sp==='vis'; }
function spriteSpectrumLabel(sp){ return isVis(sp) ? ('可见光·'+(PALETTES[sp.pal]||sp.pal)) : '红外'; }
function spriteLabel(si){ const s=SPRITES[si]; return s? (s.model+' · '+spriteSpectrumLabel(s)+' · yaw'+s.yaw+' off'+s.off) : '—'; }
/* 当前「光谱+配色」+ 该类别下的全部素材下标 */
function spritesOfCls(ci){ const idx=[]; for(let i=0;i<SPRITES.length;i++){ const s=SPRITES[i]; if(s.ci===ci && spriteMatches(s)) idx.push(i); } return idx; }
/* 从某个类别里随机挑一个素材（尽量避免与上次重复，保证视角/车型多样） */
function pickSprite(ci){
  const idx=spritesOfCls(ci);
  if(!idx.length) return -1;
  let pick=idx[Math.floor(Math.random()*idx.length)];
  if(idx.length>1 && pick===lastSiByCls[ci]) pick=idx[(idx.indexOf(pick)+1)%idx.length];
  lastSiByCls[ci]=pick;
  return pick;
}
function setStatus(t){ document.getElementById('stem').textContent = t; }
function setSaveStatus(t){ document.getElementById('saveStatus').textContent = t; }
function markDirty(){ if(curIdx>=0) dirtyMap[curIdx]=true; showSaveStatus(); }
function pendingCount(){ let p=0; for(let i=0;i<bgFiles.length;i++){ const has=(i===curIdx)?placements:(imgPlacements[i]||[]); if(has.length && (dirtyMap[i]||!savedMap[i])) p++; } return p; }
function showSaveStatus(extra){
  const el=document.getElementById('saveStatus'); if(!el) return;
  const st = savedMap[curIdx] ? '已保存' : '未保存';
  const savedN = Object.keys(savedMap).filter(k=>savedMap[k]).length;
  let t='当前图片状态：'+st+'（'+placements.length+' 个框）';
  if(bgFiles.length) t+=' · 已存 '+savedN+'/'+bgFiles.length+' 张';
  t+=' · 待保存 '+pendingCount()+' 张';
  if(extra) t+=' · '+extra;
  el.textContent=t;
}
function saveProgress(t){ document.getElementById('saveStatus').textContent=t; }
function clampz(v,a,b){ return Math.max(a,Math.min(b,v)); }
function fmtN(v){ return Number(v).toFixed(2); }
function shareName(){ return bg ? bg.name.replace(/\.[^.]+$/,'') : 'img'; }

// ===== 视图 =====
function updateView(){
  if(!bg) return;
  cv.style.width = bg.naturalWidth + 'px'; cv.style.height = bg.naturalHeight + 'px';
  cv.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+zoom+')';
  const zl=document.getElementById('v_zoom'); if(zl) zl.textContent=Math.round(100*zoom/baseZoom)+'%';
}
function centerView(){ const cw=leftEl.clientWidth, ch=leftEl.clientHeight; tx=(cw-bg.naturalWidth*zoom)/2; ty=(ch-bg.naturalHeight*zoom)/2; updateView(); }
function fitZoom(){ const cw=leftEl.clientWidth, ch=leftEl.clientHeight; zoom=bg?clampz(Math.min(cw/bg.naturalWidth,ch/bg.naturalHeight),0.05,64):1; baseZoom=zoom; centerView(); }
function wheelZoom(e){ if(!bg) return; e.preventDefault(); const lr=leftEl.getBoundingClientRect(); const mx=e.clientX-lr.left, my=e.clientY-lr.top; const oldZoom=zoom; const factor=Math.exp(-e.deltaY*0.0016); const nz=Math.min(64, Math.max(0.05, oldZoom*factor)); tx=mx-(mx-tx)*(nz/oldZoom); ty=my-(my-ty)*(nz/oldZoom); zoom=nz; updateView(); }
function imgPoint(e){ const r=cv.getBoundingClientRect(); return [(e.clientX-r.left)*(cv.width/r.width),(e.clientY-r.top)*(cv.height/r.height)]; }
function updateFileInfo(){ if(!bg) return; document.getElementById('fileInfo').textContent = bg.name+'   '+bg.naturalWidth+'x'+bg.naturalHeight+'px'; document.getElementById('bgIdx').textContent=(curIdx+1)+'/'+bgFiles.length; }
function updateImgSel(){ const sel=document.getElementById('imgSel'); sel.innerHTML=''; bgFiles.forEach((f,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=f.name; if(i===curIdx)o.selected=true; sel.appendChild(o); }); }

// ===== 几何（一律按「实体范围」计算：素材 alpha 外接框，而不是整张画布）=====
function rotatePt(px,py,cx,cy,deg){ const r=deg*Math.PI/180,c=Math.cos(r),s=Math.sin(r),dx=px-cx,dy=py-cy; return [cx+dx*c-dy*s, cy+dx*s+dy*c]; }
/* 车辆实体外接框（旋转后的 AABB，单位 px）。素材实体已居中等比归一化，bx 为素材画布内的实体半开区间 */
function entAABB(p, v){
  const s=spriteOf(p); if(!s||!v) return null;
  const k=p.size, xs=[], ys=[];
  for (const [bx,by] of [[s.bx[0],s.bx[1]],[s.bx[2],s.bx[1]],[s.bx[2],s.bx[3]],[s.bx[0],s.bx[3]]]){
    const [rx,ry]=rotatePt(p.x+(bx-s.w/2)*k, p.y+(by-s.h/2)*k, p.x, p.y, p.rot);
    xs.push(rx); ys.push(ry);
  }
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}
function aabbHit(x,y){
  for (let i=placements.length-1;i>=0;i--){ const p=placements[i], v=vehImgs[p.si]; if(!v) continue;
    const b=entAABB(p,v); if(!b) continue;
    if (x>=b[0]-6&&x<=b[2]+6&&y>=b[1]-6&&y<=b[3]+6) return i; }
  return -1;
}
function selBox(){
  if(!(selected>=0&&placements[selected])) return null;
  const p=placements[selected], v=vehImgs[p.si]; if(!v) return null;
  const b=entAABB(p,v); if(!b) return null;
  return {p,x0:b[0],y0:b[1],x1:b[2],y1:b[3],v};
}
function handles(){
  const b=selBox(); if(!b) return null;
  const R=Math.max(b.x1-b.x0, b.y1-b.y0)/2 + 24;
  const ang=(b.p.rot+90)*Math.PI/180;
  return {corners:[[b.x0,b.y0],[b.x1,b.y0],[b.x0,b.y1],[b.x1,b.y1]], rot:{x:b.p.x+R*Math.cos(ang), y:b.p.y+R*Math.sin(ang)}, b};
}


// ===== 渲染（软融合 + 亮度对齐背景 + 保留素材色彩 + 边缘羽化）=====
// 只重映射「亮度」，并保留每个像素相对亮度的色彩偏移：灰度素材偏移恒为 0，结果与旧版逐像素一致；
// 彩色素材（可见光）保持自身配色，只让明暗/对比贴合局部背景。
function sigmaRGB(d,i){ return 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; }
function alphaBlur(arr, w, h){ // 3x3 box blur 作用于 RGBA，软化车身内容与边缘
  const a0=Array.from(arr); const out=arr.slice();
  for(let y=0;y<h;y++){ for(let x=0;x<w;x++){ let sr=0,sg=0,sb=0,sa=0,c=0;
    for(let dy=-1;dy<=1;dy++){ for(let dx=-1;dx<=1;dx++){ const yy=y+dy, xx=x+dx; if(xx>=0&&xx<w&&yy>=0&&yy<h){ const idx=(yy*w+xx)*4; sr+=a0[idx]; sg+=a0[idx+1]; sb+=a0[idx+2]; sa+=a0[idx+3]; c++; } } }
    const o=(y*w+x)*4; out[o]=Math.round(sr/c); out[o+1]=Math.round(sg/c); out[o+2]=Math.round(sb/c); out[o+3]=Math.round(sa/c); } }
  return out;
}
function pasteVehicleSoft(g, bctx, W, H, p, v){
  const w=Math.max(1,Math.round(v.naturalWidth*p.size)), h=Math.max(1,Math.round(v.naturalHeight*p.size));
  const ov=document.createElement('canvas'); ov.width=w; ov.height=h;
  const octx=ov.getContext('2d'); octx.drawImage(v,0,0,w,h);
  const im=octx.getImageData(0,0,w,h), d=im.data;
  // 车辆像素亮度统计（alpha>20）
  let vS=0,vS2=0,vn=0;
  for(let i=0;i<d.length;i+=4){ if(d[i+3]>20){ const l=sigmaRGB(d,i); vS+=l; vS2+=l*l; vn++; } }
  const vMean=vn? vS/vn : 128, vStd=vn? Math.sqrt(Math.max(0,vS2/vn-vMean*vMean)) : 1;
  // 背景局部亮度统计（中心附近）
  const R=Math.max(w,h)+14;
  const bx=Math.max(0,Math.min(W, Math.round(p.x)-R)), by=Math.max(0,Math.min(H, Math.round(p.y)-R));
  const bw=Math.min(W, Math.round(p.x)+R)-bx, bh=Math.min(H, Math.round(p.y)+R)-by;
  let bMean=vMean, bStd=vStd;
  if(bw>2&&bh>2){ const bd=bctx.getImageData(bx,by,bw,bh).data; let bS=0,bS2=0,bn=0;
    for(let i=0;i<bd.length;i+=4){ const l=sigmaRGB(bd,i); bS+=l; bS2+=l*l; bn++; }
    bMean=bn? bS/bn : vMean; bStd=bn? Math.sqrt(Math.max(0,bS2/bn-bMean*bMean)) : vStd; }
  // 对齐：保留车辆自身对比(缩放为背景std*p.contrast)，亮度中心比背景低 (1-p.bright)*std（越大越暗调）
  const tgtStd=Math.max(0.05, p.contrast*bStd), center=bMean-(1-p.bright)*bStd;
  const ratio=(vStd>1e-3)? tgtStd/vStd : 1;
  for(let i=0;i<d.length;i+=4){
    const l=sigmaRGB(d,i);
    let y=(l-vMean)*ratio+center; y=y<0?0:(y>255?255:y);
    for(let c=0;c<3;c++){ const nv=y+(d[i+c]-l); d[i+c]=nv<0?0:(nv>255?255:nv); } // 保留色彩偏移
  }
  // 羽化边缘（按 p.blur 次数做 box 模糊）
  let a=d; const passes=Math.max(0,Math.min(6,Math.round(p.blur)));
  for(let k=0;k<passes;k++){ a=alphaBlur(a,w,h); }
  im.data.set(a);
  octx.putImageData(im,0,0);
  // 旋转贴到主画布
  g.save(); g.translate(p.x,p.y); g.rotate(p.rot*Math.PI/180); g.drawImage(ov,-w/2,-h/2,w,h); g.restore();
}
function renderScene(g, withBoxes, bgImg, pl){
  const W=bgImg.naturalWidth, H=bgImg.naturalHeight;
  if(!bgCanvas || bgCanvas.width!==W || bgCanvas.height!==H){ bgCanvas=document.createElement('canvas'); bgCanvas.width=W; bgCanvas.height=H; }
  const bctx=bgCanvas.getContext('2d'); bctx.clearRect(0,0,W,H); bctx.drawImage(bgImg,0,0);
  g.clearRect(0,0,W,H); g.drawImage(bgImg,0,0);
  for (const p of pl){ const v=vehImgs[p.si]; if(!v) continue; pasteVehicleSoft(g,bctx,W,H,p,v); }
  if (withBoxes){ for (let i=0;i<pl.length;i++){ const p=pl[i], v=vehImgs[p.si]; if(!v) continue;
    const b=entAABB(p,v); if(!b) continue;
    g.strokeStyle = i===selected ? '#ffff00' : 'rgba(0,255,0,0.4)'; g.lineWidth = i===selected?2:1;
    g.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]); } }
}
function redraw(){
  if(!bg) return;
  renderScene(ctx, !hideLabels, bg, placements);
  const h = handles();
  if(h && !hideLabels){
    ctx.fillStyle='#ffffff'; ctx.strokeStyle='#ffffff'; ctx.lineWidth=1;
    for (const hx of h.corners) ctx.fillRect(hx[0]-4, hx[1]-4, 8, 8);
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 7, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 3, 0, Math.PI*2); ctx.fill();
    const w=Math.round(h.b.x1-h.b.x0), hh=Math.round(h.b.y1-h.b.y0);
    const txt = w+'×'+hh+'px · 像素数'+(w*hh);
    ctx.font='12px sans-serif'; ctx.textBaseline='top';
    const tw=ctx.measureText(txt).width;
    const lx=h.b.x0, ly=Math.max(0,h.b.y0-18);
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(lx, ly, tw+8, 16);
    ctx.fillStyle='#9fe3ff'; ctx.fillText(txt, lx+4, ly+2);
  }
  setStatus('第 '+(curIdx+1)+'/'+bgFiles.length+' 张  车辆 '+placements.length+'  选中 '+(selected+1)+
    (selected>=0&&placements[selected] ? '（'+clsName(placements[selected])+' · '+spriteLabel(placements[selected].si)+'）' : '')+
    '  '+bg.naturalWidth+'x'+bg.naturalHeight);
  updateInfo(); updateSizeLabel(); updateStats();
}

// ===== 信息 =====
/* 下一个将被摆放的素材（只读，不改变随机状态） */
function plannedSi(){
  if(plan && plan.nextSi!=null && SPRITES[plan.nextSi] && spriteMatches(SPRITES[plan.nextSi])) return plan.nextSi;
  const ci=manualCls>=0?manualCls:recommendType();
  const pool=spritesOfCls(ci);
  if(pool.length) return pool[0];
  for(let i=0;i<SPRITES.length;i++) if(spriteMatches(SPRITES[i])) return i;
  return 0;
}
function updateSizeLabel(){
  const p=(selected>=0&&placements[selected])?placements[selected]:null;
  const s=SPRITES[p? p.si : plannedSi()];
  if(!s){ document.getElementById('v_size').textContent='—'; return; }
  const size=p? p.size : defSize;
  document.getElementById('v_size').textContent=Math.round((s.bx[2]-s.bx[0])*size)+'x'+Math.round((s.bx[3]-s.bx[1])*size)+'px';
}
function pxbox(p,v){ const b=entAABB(p,v); return b? [Math.round(b[0]),Math.round(b[1]),Math.round(b[2]),Math.round(b[3])] : [0,0,0,0]; }
function updateInfo(){
  const box=document.getElementById('infoBox');
  if(!(selected>=0&&placements[selected])){
    const s=SPRITES[plannedSi()];
    box.innerHTML = s ? ('（未选中车辆）<br>下一个素材：<b>'+clsName({si:plannedSi()})+' '+clsCn(SPRITES[plannedSi()].ci)+'</b><br>'+spriteLabel(plannedSi())) : '（选中车辆后显示）';
    return;
  }
  const p=placements[selected], v=vehImgs[p.si]; if(!v){ box.innerHTML='—'; return; }
  const [x0,y0,x1,y1]=pxbox(p,v); const w=x1-x0,h=y1-y0;
  box.innerHTML='<b>#'+(selected+1)+' '+clsName(p)+' '+clsCn(clsOf(p))+'</b>'+
    ' <button class="del" onclick="deleteSelected()">✕</button><br>'+
    '<b>素材</b>：'+spriteLabel(p.si)+'<br>'+
    '<b>实体框 x</b>：'+x0+' ~ '+x1+'<br><b>实体框 y</b>：'+y0+' ~ '+y1+'<br>'+
    '<b>宽×高</b>：'+w+'×'+h+' px<br><b>中心</b>：('+Math.round(p.x)+', '+Math.round(p.y)+')<br>'+
    '<b>像素数</b>：'+(w*h).toFixed(1);
}
function deleteSelected(){ if(selected>=0){ placements.splice(selected,1); selected=-1; drag=null; resize=null; rotDrag=null; redraw(); markDirty(); } }

// ===== 参数 =====
function lastParams(){ return {size:defSize,bright:0.8,contrast:1,blur:0.2,rot:defRot}; }
function setSlider(id,vid,v){ document.getElementById(id).value=v; document.getElementById(vid).textContent=fmtN(v); }
function setSlidersFrom(p){
  setSlider('r_size','v_size',p.size);setSlider('r_bright','v_bright',p.bright);setSlider('r_contrast','v_contrast',p.contrast);setSlider('r_blur','v_blur',p.blur);setSlider('r_rot','v_rot',p.rot); updateSizeLabel(); }
function setManualCls(i){ manualCls=i; const s=document.getElementById('vehSel'); if(s) s.value=String(i); updatePlan(); updateInfo(); updateSizeLabel(); }
function bindSlider(id,vid,key,fmt){
  const el=document.getElementById(id), lab=document.getElementById(vid);
  el.addEventListener('input',()=>{ const v=parseFloat(el.value); lab.textContent=fmt(v); if(key==='size') defSize=v; if(key==='rot') defRot=v; if(selected>=0&&placements[selected]) placements[selected][key]=v; redraw(); });
  lab.textContent=fmt(parseFloat(el.value));
}

// ===== 交互 =====
/* 统计只算当前「光谱 + 类别组」的 4 个类别（跨本轮所有背景图） */
function modeCounts(m){
  const ids=modeClassIds(m), tot={};
  ids.forEach(id=>{ tot[id]=0; });
  const add=(pl)=>{ (pl||[]).forEach(p=>{ const s=spriteOf(p); if(s && s.sp===spectrum && tot[s.ci]!==undefined) tot[s.ci]++; }); };
  add(placements);
  for(let i=0;i<bgFiles.length;i++){ if(i===curIdx) continue; add(imgPlacements[i]); }
  return ids.map(id=>tot[id]);
}
function updateStats(){
  const el=document.getElementById('statsInfo'); if(!el||!bgFiles) return;
  const ids=modeClassIds(mode), tot=modeCounts(mode);
  const total=tot.reduce((s,v)=>s+v,0);
  const col=['#3a7bd5','#2f9e6f','#e8910c','#b05ce8'];
  let html='<div class="stats">';
  ids.forEach((id,k)=>{
    const c=tot[k], w=total>0 ? (c/total*100) : 0;
    html+='<div class="srow" title="'+CLS[id]+' '+CLS_CN[CLS[id]]+'（类别 ID '+id+'）"><span class="slab">'+((typeof CLS_SHORT!=="undefined"&&CLS_SHORT[CLS[id]])||CLS[id])+'</span>'+
      '<span class="barwrap"><span class="bar" style="width:'+w.toFixed(1)+'%;background:'+col[k]+'"></span></span>'+
      '<span class="sval">'+c+' · '+w.toFixed(1)+'%</span></div>';
  });
  html+='<div class="stotal">'+spectrumLabel()+' · '+modeLabel(mode)+'：总目标 '+total+' 个</div></div>';
  el.innerHTML=html;
}
function globalCounts(){ return modeCounts(mode); }
function recommendType(){
  const ids=modeClassIds(mode), tot=modeCounts(mode);
  const mn=Math.min.apply(null,tot);
  const cands=ids.filter((id,k)=>tot[k]===mn);
  return cands.length ? cands[Math.floor(Math.random()*cands.length)] : (ids[0]!=null?ids[0]:0);
}
/* 光谱下拉（红外 / 可见光） */
function buildSpectrumSelect(){
  const sel=document.getElementById('spectrumSel'); if(!sel) return;
  sel.innerHTML='';
  Object.keys(SPECTRA).forEach(k=>{
    const o=document.createElement('option');
    o.value=k; o.textContent=SPECTRA[k].label; sel.appendChild(o);
  });
  sel.value=spectrum;
}
/* 配色下拉（仅可见光可选；默认全部） */
function buildPaletteSelect(){
  const sel=document.getElementById('paletteSel'); if(!sel) return;
  sel.innerHTML='';
  const all=document.createElement('option'); all.value='all'; all.textContent='全部配色'; sel.appendChild(all);
  Object.keys(PALETTES).forEach(k=>{
    if(k==='ir') return;
    const o=document.createElement('option'); o.value=k; o.textContent=PALETTES[k]; sel.appendChild(o);
  });
  sel.value=(palFilter==='all'?'all':palFilter);
  sel.disabled=(spectrum!=='vis');
  sel.title=(spectrum==='vis')?'可见光配色筛选（默认两套都能被抽到）':'配色筛选只在可见光模式下有效';
}
/* 类别下拉：按当前模式重建（value 用全局类别 ID） */
function buildVehSelect(){
  const sel=document.getElementById('vehSel'); if(!sel) return;
  sel.innerHTML='';
  const auto=document.createElement('option'); auto.value='-1'; auto.textContent='自动（推荐）'; sel.appendChild(auto);
  modeClassIds(mode).forEach((id,k)=>{
    const o=document.createElement('option');
    const n=spritesOfCls(id).length;
    o.value=String(id); o.textContent=(k+1)+' · '+CLS[id]+' '+CLS_CN[CLS[id]]+(n?'':'（本光谱/配色无素材）');
    sel.appendChild(o);
  });
  sel.value='-1';
}
/* 混用检查：本图/本批里有多少辆不属于当前「光谱 + 类别组」 */
function isForeign(p){
  const s=spriteOf(p); if(!s) return false;
  return s.sp!==spectrum || modeClassIds(mode).indexOf(s.ci)<0;
}
function mixCounts(){
  const count=(pl)=>{ let n=0; (pl||[]).forEach(p=>{ if(isForeign(p)) n++; }); return n; };
  let all=count(placements);
  for(let i=0;i<bgFiles.length;i++){ if(i===curIdx) continue; all+=count(imgPlacements[i]); }
  return {cur:count(placements), all:all};
}
function updateMixInfo(){
  const el=document.getElementById('mixInfo'), btn=document.getElementById('cleanOther');
  if(!el) return;
  const m=mixCounts();
  if(m.all>0){
    el.style.display=''; if(btn) btn.style.display='';
    el.innerHTML='⚠ 当前图有 <b>'+m.cur+'</b> 辆、本批共 <b>'+m.all+'</b> 辆不属于当前「'+spectrumLabel()+' · '+modeLabel(mode)+'」，'+
      '导出时会一起写进 XML（类别名不会错，但两套数据就混了）。';
  } else {
    el.style.display='none'; if(btn) btn.style.display='none';
  }
}
/* 把本图里不属于当前光谱/模式的车一次性删掉 */
function cleanOtherMode(){
  const before=placements.length;
  placements=placements.filter(p=>!isForeign(p));
  const removed=before-placements.length;
  if(removed>0){ if(selected>=placements.length) selected=-1; redraw(); markDirty(); updateMixInfo(); updateStats(); updatePlan(); updateInfo(); }
  setStatus(removed>0 ? ('已删除本图 '+removed+' 辆不属于当前光谱/模式的车') : '本图没有其他光谱/模式的车');
}
/* 切换类别组（基础四类 / 类增量新四类）：只换类别表与可选材料，不重新加载素材 */
function switchMode(m){
  if(m===mode || !MODES[m]) return;
  mode=m;
  const sel=document.getElementById('modeSel'); if(sel) sel.value=m;
  manualCls=-1; lastSiByCls={}; lastPlacedSiByCls={};
  buildVehSelect(); buildModeSelect(); genPlan(); updateStats(); updateInfo(); updateSizeLabel(); updateMixInfo(); showSaveStatus(); redraw();
  setStatus('已切到「'+modeLabel(m)+'」：'+spectrumLabel()+' 素材 '+modeSpriteCount(spectrum,m,palFilter)+' 个 · 类别 '+modeClasses(m).join(' / ')+
            '（键盘 1-4 对应本组四类；两套数据请分别保存到不同目录）');
}
/* 切换光谱（红外 / 可见光）与配色筛选：按需加载素材文件，已有标注不丢 */
async function switchSpectrum(sp, pal){
  const nextPal = (sp==='vis') ? (pal || (palFilter==='all'?'all':palFilter)) : 'ir';
  if(sp===spectrum && (sp!=='vis' || nextPal===palFilter)) return;
  try{ await ensureGroups(sp, nextPal); }
  catch(e){ setStatus('素材加载失败：'+(e&&e.message||e)); return; }
  spectrum=sp; palFilter=nextPal;
  setSaveStatus('正在加载「'+spectrumLabel()+'」素材图片…');
  await loadPoolImages();
  manualCls=-1; lastSiByCls={}; lastPlacedSiByCls={};
  buildSpectrumSelect(); buildPaletteSelect(); buildVehSelect(); buildModeSelect();
  genPlan(); updateStats(); updateInfo(); updateSizeLabel(); updateMixInfo(); showSaveStatus(); redraw();
  setStatus('已切到「'+spectrumLabel()+(spectrum==='vis'?(' · '+(palFilter==='all'?'全部配色':(PALETTES[palFilter]||palFilter))):'')+
            '」：本组可用素材 '+modeSpriteCount(spectrum, mode, palFilter)+' 个。另一光谱/模式的车不会被删除，但会提示混用。');
}
function genPlan(){ plan={count:2+Math.floor(Math.random()*5), nextSi:pickSprite(recommendType())}; updatePlan(); updateInfo(); updateSizeLabel(); }
function updatePlan(){
  const el=document.getElementById('planInfo'); if(!el||!plan) return;
  const n=plan.count, cur=placements.length;
  let s='本图建议 <b>'+n+'</b> 辆（按全图占比自动平衡车型，目标每类约25%）';
  s+='<br>已放 <b>'+cur+'</b>/'+n;
  if(manualCls>=0){ s+=' · <b>已手动选 '+CLS[manualCls]+' '+CLS_CN[CLS[manualCls]]+'</b>（下一辆生效，之后回自动）'; }
  else if(cur<n){ const r=recommendType(); s+=' · 下一个：<b>'+CLS[r]+' '+CLS_CN[CLS[r]]+'</b>'+(plan.nextSi!=null?'（素材 '+spriteLabel(plan.nextSi)+'）':''); }
  else s+=' · <b>✓ 已完成</b>';
  el.innerHTML=s;
}
function placeVehicleAt(ix,iy,rot){
  let ci;
  if(manualCls>=0){ ci=manualCls; manualCls=-1; const s=document.getElementById('vehSel'); if(s) s.value='-1'; }
  else ci=recommendType();
  let si=(plan && plan.nextSi!=null && SPRITES[plan.nextSi] && SPRITES[plan.nextSi].ci===ci && spriteMatches(SPRITES[plan.nextSi])) ? plan.nextSi : pickSprite(ci);
  if(si<0) si=pickSprite(ci);
  if(si<0) return;
  // 严格避免「同一类别连续两次用同一个素材」：与上一次**实际摆放**比对，而不只是与预览记录比对
  const pool=spritesOfCls(ci);
  if(pool.length>1 && lastPlacedSiByCls[ci]===si){
    const others=pool.filter(x=>x!==si);
    si=others[Math.floor(Math.random()*others.length)];
  }
  lastPlacedSiByCls[ci]=si; lastSiByCls[ci]=si;
  const np=Object.assign({si:si,x:ix,y:iy,rot:rot},lastParams());
  placements.push(np); selected=placements.length-1; setSlidersFrom(np);
  plan.nextSi=pickSprite(recommendType()); // 下一辆的素材（按摆放后的最新占比推荐）
  redraw(); updatePlan(); updateInfo(); markDirty();
}
function onDown(e){
  if(e.button===2){ pan={baseTx:tx,baseTy:ty,mx:e.clientX,my:e.clientY}; return; }
  if(e.button!==0) return;
  const [ix,iy]=imgPoint(e);
  // 手柄优先：选中车上的角(缩放) / 旋转点
  const h=handles();
  if(h){
    for (const cxy of h.corners){ if(Math.hypot(ix-cxy[0],iy-cxy[1])<11){ resize={index:selected,startDist:Math.hypot(ix-h.b.p.x,iy-h.b.p.y),startSize:h.b.p.size}; pending=null; markDirty(); return; } }
    if(Math.hypot(ix-h.rot.x,iy-h.rot.y)<12){ rotDrag={index:selected}; pending=null; markDirty(); return; }
  }
  const hit=aabbHit(ix,iy);
  if(hit>=0){ selected=hit; setSlidersFrom(placements[hit]); drag={index:hit,ox:placements[hit].x-ix,oy:placements[hit].y-iy}; pending=null; markDirty(); redraw(); }
  else pending={ix,iy,clientX:e.clientX,clientY:e.clientY};
}
function onMove(e){
  const [ix,iy]=imgPoint(e);
  if(pan){ tx=pan.baseTx+(e.clientX-pan.mx); ty=pan.baseTy+(e.clientY-pan.my); updateView(); return; }
  if(resize){ const p=placements[resize.index]; const d=Math.hypot(ix-p.x,iy-p.y); const f=d/Math.max(1,resize.startDist); p.size=clampz(resize.startSize*f,0.005,0.9); defSize=p.size; redraw(); return; }
  if(rotDrag){ const p=placements[rotDrag.index]; p.rot=Math.atan2(iy-p.y,ix-p.x)*180/Math.PI-90; defRot=p.rot; redraw(); return; }
  if(drag){ const p=placements[drag.index]; p.x=ix-drag.ox; p.y=iy-drag.oy; redraw(); return; }
  if(pending&&(Math.abs(e.clientX-pending.clientX)+Math.abs(e.clientY-pending.clientY)>6)){ selected=-1; pan={baseTx:tx,baseTy:ty,mx:e.clientX,my:e.clientY}; pending=null; }
}
function onUp(){ if(pan){pan=null;return;} if(drag){drag=null;return;} if(resize){resize=null;return;} if(rotDrag){rotDrag=null;return;} if(pending){ placeVehicleAt(pending.ix,pending.iy,0); pending=null; } }

// ===== 多图 =====
function saveCurrentPlacements(){ if(curIdx>=0) imgPlacements[curIdx]=placements.slice(); }
function loadCurrent(){
  if(curIdx<0||curIdx>=bgFiles.length) return;
  bg=bgFiles[curIdx].img; cv.width=bg.naturalWidth; cv.height=bg.naturalHeight;
  placements=imgPlacements[curIdx]||[]; selected=-1; drag=null; pan=null; pending=null; resize=null; rotDrag=null; 
  fitZoom(); redraw(); updateFileInfo(); updateImgSel();
  showSaveStatus();
  updateStats(); updateMixInfo();
  genPlan();
}
function goto(delta){ const n=clampz(curIdx+delta,0,bgFiles.length-1); if(n===curIdx) return; saveCurrentPlacements(); curIdx=n; loadCurrent(); }
function jumpTo(i){ const n=clampz(i,0,bgFiles.length-1); if(n===curIdx) return; saveCurrentPlacements(); curIdx=n; loadCurrent(); }

// ===== 保存/导出 =====
function buildLabels(bgImg,pl){
  const W=bgImg.naturalWidth,H=bgImg.naturalHeight, stem=bgImg.name.replace(/\.[^.]+$/,'');
  let voc='<?xml version="1.0" encoding="utf-8"?>\n<annotation>\n  <filename>'+stem+'_composite.png</filename>\n  <size><width>'+W+'</width><height>'+H+'</height><depth>1</depth></size>\n';
  for(const p of pl){ const v=vehImgs[p.si]; if(!v) continue; const b=entAABB(p,v); if(!b) continue;
    const xx0=Math.max(0,b[0]),yy0=Math.max(0,b[1]),xx1=Math.min(W,b[2]),yy1=Math.min(H,b[3]); if(xx1<=xx0||yy1<=yy0) continue;
    voc+='  <object><name>'+clsName(p)+'</name><bndbox><xmin>'+Math.round(xx0)+'</xmin><xmax>'+Math.round(xx1)+'</xmax><ymin>'+Math.round(yy0)+'</ymin><ymax>'+Math.round(yy1)+'</ymax></bndbox></object>\n'; }
  voc+='</annotation>\n';
  return {stem,voc};
}
function dataURLToBlob(u){ try{ const [head, b64]=u.split(','); const mm=head.match(/data:(.*?)(;|$)/); const bin=atob(b64); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); return new Blob([arr],{type:mm?mm[1]:'image/png'}); }catch(e){ return null; } }
function compositeBlob(bgImg,pl){
  const c=document.createElement('canvas'); c.width=bgImg.naturalWidth; c.height=bgImg.naturalHeight;
  const g=c.getContext('2d');
  renderScene(g,false,bgImg,pl);
  return new Promise(res=>{
    try{
      c.toBlob(b=>{ if(b && b.size>0) res(b); else res(dataURLToBlob(c.toDataURL('image/png'))); }, 'image/png');
    }catch(e){
      try{ res(dataURLToBlob(c.toDataURL('image/png'))); }catch(e2){ res(null); }
    }
  });
}
async function writeFile(dir,name,data){ const fh=await dir.getFileHandle(name,{create:true}); const ws=await fh.createWritable(); await ws.write(data); await ws.close(); }
function download(name,blob){
  try{
    const a=document.createElement('a'); const url=URL.createObjectURL(blob);
    a.href=url; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1200);
  }catch(e){ alert('下载失败：'+(e&&e.message||e)); }
}
function setDirInfo(){ document.getElementById('dirInfo').innerHTML='已选择: <b class="fname">'+saveRoot.name+'</b> （点击更改）'; }
async function pickDir(){ if(!window.showDirectoryPicker){ alert('该浏览器不支持文件夹选择'); return; } try{ saveRoot=await window.showDirectoryPicker({mode:'readwrite'}); setDirInfo(); }catch(err){} }
async function ensureRoot(){ if(saveRoot) return saveRoot; if(!window.showDirectoryPicker) return null; try{ saveRoot=await window.showDirectoryPicker({mode:'readwrite'}); setDirInfo(); return saveRoot; }catch(err){ return null; } }
function exportJSON(){ if(!bg) return; const data={image:bg.name,width:bg.naturalWidth,height:bg.naturalHeight,boxes:placements.map(p=>({class:clsName(p),sprite:(SPRITES[p.si]||{}).n||'',cx:Math.round(p.x),cy:Math.round(p.y),rot:p.rot,size:p.size,bright:p.bright,contrast:p.contrast,blur:p.blur}))}; download(shareName()+'.json',new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); }
function validBlob(b){ return b && b.size>0; }
/* 保存状态里的光谱/模式标记与混用提醒 */
function saveTag(pl){
  let n=0;
  (pl||[]).forEach(p=>{ if(isForeign(p)) n++; });
  return spectrumLabel()+'·'+modeLabel(mode)+(n>0 ? ' · ⚠ 含 '+n+' 辆不属当前光谱/模式' : '');
}
async function saveCurrent(){
  if(!bg){ alert('先加载背景图'); return; }
  try{
    const png=await compositeBlob(bg,placements); const {stem,voc}=buildLabels(bg,placements);
    if(!validBlob(png)){ alert('图片导出失败（画布可能被污染，或浏览器不支持），请刷新重试。'); return; }
    saveProgress('正在保存当前 「'+stem+'」…');
    const root=await ensureRoot();
    if(root){ try{ const imgDir=await root.getDirectoryHandle('images',{create:true}); const xmlDir=await root.getDirectoryHandle('xml',{create:true});
      await writeFile(imgDir,stem+'_composite.png',png); await writeFile(xmlDir,stem+'.xml',new Blob([voc],{type:'text/xml'}));
      savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus(saveTag(placements)+' · 本张已保存 → images/+xml/'); }
      catch(err){ if(err&&err.name!=='AbortError'){ alert('写入文件夹失败：'+(err.message||err)+'。已改为下载。'); download(stem+'_composite.png',png); download(stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus(saveTag(placements)+' · 已下载 无框图+xml（文件夹写入失败回退）'); } } }
    else { download(stem+'_composite.png',png); download(stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus(saveTag(placements)+' · 已下载 无框图+xml（需本地服务才能“存文件夹”）'); }
  } catch(err){ alert('保存出错：'+(err&&err.message||err)); }
}
async function saveAll(){
  if(!bgFiles.length){ alert('先加载背景图'); return; }
  try{
    saveCurrentPlacements();
    const items=[]; for(let i=0;i<bgFiles.length;i++){ const pl=imgPlacements[i]||[]; if(pl.length && (dirtyMap[i]||!savedMap[i])) items.push({idx:i,bgImg:bgFiles[i].img,pl,stem:bgFiles[i].img.name.replace(/\.[^.]+$/,'')}); }
    if(!items.length){ alert('没有需要保存的图（都已保存且未修改）'); return; }
    const root=await ensureRoot();
    if(root){ try{ const imgDir=await root.getDirectoryHandle('images',{create:true}); const xmlDir=await root.getDirectoryHandle('xml',{create:true});
      for(let k=0;k<items.length;k++){ const it=items[k];
        saveProgress('正在保存 '+(k+1)+'/'+items.length+'：「'+it.stem+'」…');
        const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl);
        await writeFile(imgDir,it.stem+'_composite.png',png); await writeFile(xmlDir,it.stem+'.xml',new Blob([voc],{type:'text/xml'}));
        savedMap[it.idx]=true; dirtyMap[it.idx]=false;
      }
      showSaveStatus(saveTag(items.map(it=>it.pl).flat())+' · 本次增量保存完成，共 '+items.length+' 张'); }
      catch(err){ if(err&&err.name!=='AbortError'){ alert('写入文件夹失败：'+(err.message||err)+'。已改为逐个下载。'); for(const it of items){ const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl); download(it.stem+'_composite.png',png); download(it.stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[it.idx]=true; dirtyMap[it.idx]=false; } showSaveStatus(saveTag(items.map(it=>it.pl).flat())+' · 已下载新增 '+items.length+' 张（文件夹写入失败回退）'); } } }
    else { for(let k=0;k<items.length;k++){ const it=items[k]; saveProgress('正在保存 '+(k+1)+'/'+items.length+'：「'+it.stem+'」…'); const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl); download(it.stem+'_composite.png',png); download(it.stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[it.idx]=true; dirtyMap[it.idx]=false; } showSaveStatus(saveTag(items.map(it=>it.pl).flat())+' · 已下载新增 '+items.length+' 张（需本地服务才能“存文件夹”）'); }
  } catch(err){ alert('保存出错：'+(err&&err.message||err)); }
}

// ===== 初始化 =====
function loadImageFiles(files){ const reads=Array.from(files).map(f=>new Promise(res=>{ const rd=new FileReader(); rd.onload=()=>{ const img=new Image(); img.onload=()=>{ img.name=f.name; res({name:f.name,img}); }; img.src=rd.result; }; rd.readAsDataURL(f); })); Promise.all(reads).then(list=>{ if(!list.length) return; bgFiles=list.filter(x=>x&&x.img); curIdx=0; imgPlacements={}; placements=[]; savedMap={}; dirtyMap={}; loadCurrent(); setStatus('已加载 '+bgFiles.length+' 张背景'); }); }
function handleDrop(e){
  e.preventDefault();
  const items = e.dataTransfer && e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
  const entries = [];
  for (const it of items){ const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (en) entries.push(en); }
  if (!entries.length){ if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadImageFiles(e.dataTransfer.files); return; }
  const files = [];
  const readEntry = (entry) => new Promise(res => {
    if (!entry){ res(); return; }
    if (entry.isFile){ entry.file(f=>{ files.push(f); res(); }, ()=>res()); }
    else if (entry.isDirectory){ const rd = entry.createReader(); const readBatch = ()=> rd.readEntries(batch=>{ if(batch.length){ batch.forEach(readEntry); readBatch(); } else res(); }, ()=>res()); readBatch(); }
    else res();
  });
  Promise.all(entries.map(readEntry)).then(()=>loadImageFiles(files));
}
function init(){
  document.getElementById('folderInput').addEventListener('change',e=>{ if(e.target.files.length) loadImageFiles(e.target.files); });
  document.getElementById('modeSel').addEventListener('change',e=>switchMode(e.target.value));
  document.getElementById('spectrumSel').addEventListener('change',e=>switchSpectrum(e.target.value));
  document.getElementById('paletteSel').addEventListener('change',e=>switchSpectrum(spectrum, e.target.value));
  document.getElementById('cleanOther').addEventListener('click',cleanOtherMode);
  document.getElementById('vehSel').addEventListener('change',e=>{ const v=parseInt(e.target.value); if(v>=0) setManualCls(v); else { manualCls=-1; updatePlan(); updateInfo(); updateSizeLabel(); } });
  document.getElementById('fitBtn').addEventListener('click',fitZoom);
  document.getElementById('clear').addEventListener('click',()=>{ placements=[]; selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  document.getElementById('clear2').addEventListener('click',()=>{ placements=[]; selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  document.getElementById('hideLabels').addEventListener('change',e=>{ hideLabels=e.target.checked; redraw(); });
  document.getElementById('prev').addEventListener('click',()=>goto(-1));
  document.getElementById('next').addEventListener('click',()=>goto(1));
  document.getElementById('prev2').addEventListener('click',()=>goto(-1));
  document.getElementById('next2').addEventListener('click',()=>goto(1));
  document.getElementById('imgSel').addEventListener('change',e=>jumpTo(parseInt(e.target.value)));
  document.getElementById('replan').addEventListener('click',genPlan);
  document.getElementById('pickDir').addEventListener('click',pickDir);
  function flash(btn){ /* 轻提示：仅加一个短暂的按压缩放/反白（不改持久颜色） */ }
  document.getElementById('saveCur').addEventListener('click',()=>saveCurrent());
  document.getElementById('saveAll').addEventListener('click',()=>saveAll());
  document.getElementById('undo').addEventListener('click',()=>{ if(placements.length) placements.pop(); if(selected>=placements.length) selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  cv.addEventListener('mousedown',onDown); cv.addEventListener('mousemove',onMove); cv.addEventListener('mouseup',onUp);
  cv.addEventListener('contextmenu',e=>e.preventDefault()); cv.addEventListener('wheel',wheelZoom,{passive:false});
  window.addEventListener('dragover',e=>{ e.preventDefault(); });
  window.addEventListener('drop',handleDrop);
  bindSlider('r_size','v_size','size',fmtN); bindSlider('r_bright','v_bright','bright',fmtN); bindSlider('r_contrast','v_contrast','contrast',fmtN); bindSlider('r_blur','v_blur','blur',fmtN); bindSlider('r_rot','v_rot','rot',fmtN);
  document.addEventListener('keydown',e=>{ if(e.key>='1'&&e.key<='4'){ const ids=modeClassIds(mode); if(ids[parseInt(e.key)-1]!=null) setManualCls(ids[parseInt(e.key)-1]); } else if(e.key==='z'){ if(placements.length) placements.pop(); redraw(); } else if(e.key==='c'||e.key==='C'){ placements=[]; redraw(); } else if(e.key==='s'||e.key==='S') saveCurrent(); else if(e.key==='ArrowLeft') goto(-1); else if(e.key==='ArrowRight') goto(1); else if(e.key==='Delete'||e.key==='Backspace'){ if(selected>=0){ e.preventDefault(); deleteSelected(); } } });
}
/* 类别组下拉：按 MODES 生成，带当前光谱下的素材数 */
function buildModeSelect(){
  const sel=document.getElementById('modeSel'); if(!sel) return;
  sel.innerHTML='';
  Object.keys(MODES).forEach(k=>{
    const o=document.createElement('option');
    o.value=k; o.textContent=modeLabel(k)+'（'+modeSpriteCount(spectrum,k,palFilter)+' 素材）';
    sel.appendChild(o);
  });
  sel.value=mode;
}
init();
initVehicles().then(()=>{
  buildSpectrumSelect(); buildPaletteSelect(); buildVehSelect(); buildModeSelect();
  setStatus('素材已加载：'+spectrumLabel()+' · '+modeLabel(mode)+' '+modeSpriteCount(spectrum,mode,palFilter)+' 个素材 · 类别 '+modeClasses(mode).join(' / ')+
            '。打开一个背景图文件夹：点空白=放车（自动按类别挑车型/视角，1-4 可指定类别）；顶部可切「光谱（红外/可见光）」「配色」「类别组」。');
  updateStats(); updateMixInfo();
});
