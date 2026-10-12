// Injected into a public LinkedIn/X embed by src/lib/debrief/capture.ts (port of the
// industry-debrief-video skill's cap.mjs). Returns the DOM rects of the sentences to
// spotlight, who posted, the crop offset and the page height, in CSS px.
window.__debriefLocate = function (marks, from) {
  for (const e of document.querySelectorAll('body *')) {
    const st = getComputedStyle(e);
    if (st.position === 'fixed' || st.position === 'sticky') e.style.display = 'none';
  }
  const nodes = []; let full = '';
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { nodes.push([w.currentNode, full.length]); full += w.currentNode.nodeValue; }
  const loc = i => { let n = nodes[0]; for (const x of nodes) { if (x[1] <= i) n = x; else break; } return [n[0], i - n[1]]; };
  const norm = s => s.replace(/[’']/g, "'");
  const res = {};
  for (const m of marks) {
    const i = norm(full).indexOf(norm(m));
    if (i < 0) { res[m] = null; continue; }
    const rg = document.createRange(); const [a, ao] = loc(i), [c, co] = loc(i + m.length);
    rg.setStart(a, ao); rg.setEnd(c, co);
    const lines = [];
    for (const q of rg.getClientRects()) {
      if (q.width < 2) continue;
      const L = lines.find(l => Math.abs(l.y - q.top) < 4);
      if (L) { L.x0 = Math.min(L.x0, q.left); L.x1 = Math.max(L.x1, q.right); L.h = Math.max(L.h, q.height); }
      else lines.push({ y: q.top + scrollY, x0: q.left, x1: q.right, h: q.height });
    }
    res[m] = lines.map(l => [Math.round(l.x0), Math.round(l.y), Math.round(l.x1 - l.x0), Math.round(l.h)]);
  }
  const lines = document.body.innerText.split('\n').map(x => x.trim()).filter(Boolean);
  let who = null;
  if (location.hostname.includes('linkedin')) {
    const av = [...document.querySelectorAll('*')].find(e => getComputedStyle(e).backgroundImage !== 'none');
    const q = av && av.getBoundingClientRect();
    who = { name: lines[0], role: (lines[1] || '').split('|')[0].trim(), age: lines[2], avatar: q && q.width < 80 ? [q.left, q.top, q.width, q.height].map(Math.round) : null };
  } else if (location.hostname.includes('twitter')) {
    const img = [...document.querySelectorAll('img')].find(i => i.src.includes('profile_images'));
    const q = img && img.getBoundingClientRect();
    const d = lines.find(l => /· \w{3} \d{1,2}, \d{4}$/.test(l));
    const hrs = d ? Math.max(1, Math.round((Date.now() - Date.parse(d.replace(' · ', ' '))) / 36e5)) : null;
    who = { name: img ? lines[0] : undefined, role: lines[1], age: hrs === null ? '' : hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`, src: 'X', avatar: q ? [q.left, q.top, q.width, q.height].map(Math.round) : null };
  }
  let fromY;
  if (from) {
    fromY = null;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const i = tw.currentNode.nodeValue.indexOf(from);
      if (i >= 0) { const g = document.createRange(); g.setStart(tw.currentNode, i); g.setEnd(tw.currentNode, i + 1); fromY = Math.round(g.getBoundingClientRect().top + scrollY) - 8; break; }
    }
  }
  return { marks: res, who, from: fromY, H: document.documentElement.scrollHeight, textLength: full.trim().length };
};
