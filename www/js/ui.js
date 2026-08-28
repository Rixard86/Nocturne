/* ---------- helpers ---------- */
const $=id=>document.getElementById(id);
function fmtTimeOfDay(d){return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
function fmtDur(s){const m=Math.floor(s/60),ss=Math.floor(s%60);return m+":"+String(ss).padStart(2,'0');}
function fmtMin(s){const m=Math.round(s/60);return m+" min";}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);}
function tick(){$('clock').textContent=fmtTimeOfDay(new Date());}
tick();setInterval(tick,10000);

/* scoring band */
function band(score){
  if(score<25) return {name:'Quiet', col:'var(--good)', bg:'rgba(90,209,168,.15)'};
  if(score<50) return {name:'Light', col:'var(--sig-a)', bg:'rgba(56,225,198,.15)'};
  if(score<75) return {name:'Loud', col:'var(--sig-b)', bg:'rgba(124,124,240,.18)'};
  return {name:'Epic', col:'var(--flag)', bg:'rgba(245,182,96,.18)'};
}

export { $, band, fmtDur, fmtMin, toast };
