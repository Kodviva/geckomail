// Gözcü noktaları + logo kurbağası fareyi AKICI takip eder: her kare göz bebeğini hedefe
// doğru yumuşatır (ease), böylece seyrek mousemove olayları ve kare düşmeleri titremeye
// dönüşmez. Her göz geometrisini DOM'dan bildirir (viewBox + soket + bebek yarıçapı) → statü
// gözleri ve 1024'lük logo aynı kodla çalışır. Pahalı getBoundingClientRect yalnız tarama
// anında (scroll/resize/DOM değişimi); her kare sadece aritmetik + setAttribute → düşük gecikme.

interface Meta { scx: number; scy: number; restX: number; restY: number; travel: number }
interface Rec { pupil: SVGCircleElement; m: Meta; ex: number; ey: number; cx: number; cy: number }

const EASE = 0.3 // kare başına hedefe yaklaşma oranı (akıcılık ↔ tepki dengesi)
let mx = 0
let my = 0
let lastMove = -Infinity // açılışta idle (kırpar); ilk hareketle takip başlar
let running = false
let idle = false
let needScan = true
let recs: Rec[] = []
const metaMap = new WeakMap<SVGCircleElement, Meta>() // authored geometriyi bir kez yakala

function num(el: Element, a: string, d = 0): number {
  const v = parseFloat(el.getAttribute(a) || '')
  return Number.isFinite(v) ? v : d
}

function metaFor(socket: SVGCircleElement, pupil: SVGCircleElement): Meta {
  let m = metaMap.get(pupil)
  if (!m) {
    const scx = num(socket, 'cx')
    const scy = num(socket, 'cy')
    const sr = num(socket, 'r')
    const pr = num(pupil, 'r')
    m = { scx, scy, restX: num(pupil, 'cx', scx), restY: num(pupil, 'cy', scy), travel: Math.max(0, sr - pr - sr * 0.14) }
    metaMap.set(pupil, m)
  }
  return m
}

function pushRec(list: Rec[], prev: Map<SVGCircleElement, Rec>, svg: SVGSVGElement, socket: SVGCircleElement, pupil: SVGCircleElement): void {
  const rect = svg.getBoundingClientRect()
  if (!rect.width) return // görünmez panel
  const vb = svg.viewBox?.baseVal
  const vw = vb && vb.width ? vb.width : 10
  const vh = vb && vb.height ? vb.height : 10
  const m = metaFor(socket, pupil)
  const old = prev.get(pupil)
  list.push({
    pupil,
    m,
    ex: rect.left + (m.scx / vw) * rect.width, // gözün ekran merkezi
    ey: rect.top + (m.scy / vh) * rect.height,
    cx: old ? old.cx : m.restX, // mevcut bebek konumunu koru → yeniden taramada sıçrama yok
    cy: old ? old.cy : m.restY
  })
}

function rescan(): void {
  const prev = new Map<SVGCircleElement, Rec>()
  for (const r of recs) prev.set(r.pupil, r)
  const list: Rec[] = []
  document.querySelectorAll<SVGSVGElement>('svg.eye').forEach((svg) => {
    const c = svg.querySelectorAll<SVGCircleElement>('circle')
    if (c.length >= 2) pushRec(list, prev, svg, c[0], c[c.length - 1])
  })
  document.querySelectorAll<SVGSVGElement>('svg.logo-mark').forEach((svg) => {
    const fills = svg.querySelectorAll<SVGCircleElement>('.logo-fill')
    const cuts = svg.querySelectorAll<SVGCircleElement>('.logo-cut')
    const n = Math.min(fills.length, cuts.length)
    for (let i = 0; i < n; i++) pushRec(list, prev, svg, fills[i], cuts[i])
  })
  recs = list
  needScan = false
}

function frame(): void {
  if (!running) return
  if (needScan) rescan()
  const now = performance.now()
  const wantIdle = now - lastMove > 2600
  if (wantIdle !== idle) {
    idle = wantIdle
    document.documentElement.classList.toggle('eyes-idle', idle) // kırpma CSS'i
  }
  if (idle) {
    running = false // gazı son baktığı yerde bırak (sıfırlama yok), kırpmayı CSS sürdürür; sonraki harekette devam
    return
  }
  for (const r of recs) {
    const dx = mx - r.ex
    const dy = my - r.ey
    const d = Math.hypot(dx, dy) || 1
    const tx = r.m.scx + (dx / d) * r.m.travel
    const ty = r.m.scy + (dy / d) * r.m.travel
    r.cx += (tx - r.cx) * EASE
    r.cy += (ty - r.cy) * EASE
    r.pupil.setAttribute('cx', r.cx.toFixed(2))
    r.pupil.setAttribute('cy', r.cy.toFixed(2))
  }
  requestAnimationFrame(frame) // aktifken sürekli dön (idle geçişini yakalamak için)
}

function kick(): void {
  if (!running) {
    running = true
    requestAnimationFrame(frame)
  }
}

function onMove(e: MouseEvent): void {
  mx = e.clientX
  my = e.clientY
  lastMove = performance.now()
  kick()
}

export function startEyeTracker(): void {
  if (typeof window === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return // hareket duyarlılığı: kapalı
  window.addEventListener('mousemove', onMove, { passive: true })
  const invalidate = (): void => {
    needScan = true
    if (!idle) kick() // idle'ken taramayı sonraki harekete ertele (boş dönme yok)
  }
  window.addEventListener('scroll', invalidate, { passive: true, capture: true })
  window.addEventListener('resize', invalidate, { passive: true })
  // geç render edilen / yeni açılan gözleri yakala; mail akışında sürekli mutasyon → 400ms'de bir tara
  if (typeof MutationObserver !== 'undefined') {
    let pending = false
    const mo = new MutationObserver(() => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        invalidate()
      }, 400)
    })
    mo.observe(document.body, { childList: true, subtree: true })
  }
  kick()
}
